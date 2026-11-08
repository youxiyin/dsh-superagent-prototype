/** Read a fleet run's meta, parse critic evidence, and record a delegation on its Ticket. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Delegation, Ticket } from '../../core/model.ts'

/** What a run's `meta.json` says about the actual worker, and whether this run wrote a fresh report. */
export interface RunOutcome {
  worker: string
  family: string
  routeId?: string
  model?: string
  status: string
  errorClass?: string
  reportExists: boolean
  role?: string
  runDir?: string
}

interface Meta {
  status?: unknown
  worker?: unknown
  family?: unknown
  role?: unknown
  report_exists?: unknown
  error_class?: unknown
  route_id?: unknown
  model?: unknown
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const optional = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** The names of the run directories that already exist under `<taskDir>/runs/`, as a dispatch-time snapshot. */
export function knownRunDirs(taskDir: string): Set<string> {
  try {
    return new Set(readdirSync(join(taskDir, 'runs'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name))
  } catch { return new Set() }
}

/**
 * Read one run's meta. Without an explicit run directory this is `missing-run-dir`, never a fallback to the newest
 * historical run; a missing or unreadable meta is `missing-meta`. Neither throws.
 */
export function readRunOutcome(taskDir: string, runDir?: string): RunOutcome {
  if (!runDir) return { worker: '', family: '', status: 'unknown', errorClass: 'missing-run-dir', reportExists: false }
  const directory = runDir
  const unknown: RunOutcome = { worker: '', family: '', status: 'unknown', errorClass: 'missing-meta', reportExists: false }
  let meta: Meta
  try { meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')) as Meta }
  catch { return unknown }
  return {
    worker: text(meta.worker), family: text(meta.family), status: text(meta.status) || 'unknown',
    reportExists: meta.report_exists === true,
    ...(optional(meta.route_id) ? { routeId: optional(meta.route_id) } : {}),
    ...(optional(meta.model) ? { model: optional(meta.model) } : {}),
    ...(optional(meta.error_class) ? { errorClass: optional(meta.error_class) } : {}),
    ...(optional(meta.role) ? { role: optional(meta.role) } : {}),
    runDir: directory,
  }
}

/**
 * Parse only fleet's exact `结论：通过/需返工/返工` lines after removing heading and emphasis markers. Rework wins
 * wherever it appears; negated, qualified, or unrecognized values contribute nothing and leave the review `unknown`.
 */
export function parseReviewConclusion(text: string): NonNullable<Delegation['reviewConclusion']> {
  const stripEmphasis = (value: string): string => value.replace(/^[*_]+|[*_]+$/g, '')
  let pass = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripEmphasis(rawLine.trim().replace(/^#+\s*/, ''))
    const match = /^结论\s*[：:]\s*(.*)$/.exec(line)
    if (!match) continue
    const value = stripEmphasis(match[1]!.trim())
    if (value === '需返工' || value === '返工') return 'rework'
    if (value === '通过') pass = true
  }
  return pass ? 'pass' : 'unknown'
}

/** Read this review's conclusion from `<taskDir>/review.md`; a missing or unreadable file is `unknown`, never a pass. */
export function readReviewConclusion(taskDir: string): NonNullable<Delegation['reviewConclusion']> {
  try { return parseReviewConclusion(readFileSync(join(taskDir, 'review.md'), 'utf8')) }
  catch { return 'unknown' }
}

/**
 * Attribute a run directory to this dispatch: by real path it must be a direct child of `<taskDir>/runs/`, and its name
 * must not have existed in the dispatch-time snapshot. Anything else, including a nested historical directory such as
 * `runs/old/cached`, is not this dispatch's own run. Returns the verified real path, not the caller's raw string.
 */
export function attributeRunDir(taskDir: string, runDir: string | undefined, known: ReadonlySet<string>): string | undefined {
  if (!runDir) return undefined
  let runsRoot: string, realRun: string
  try {
    runsRoot = realpathSync(join(realpathSync(taskDir), 'runs'))
    realRun = realpathSync(runDir)
  } catch { return undefined }
  if (dirname(realRun) !== runsRoot) return undefined
  if (!statSync(realRun).isDirectory()) return undefined
  if (known.has(basename(realRun))) return undefined
  return realRun
}

/** The run directory named by the last result line of `fleet run`'s stdout, when that directory exists. */
export function runDirFromStdout(stdout: string): string | undefined {
  let found: string | undefined
  for (const line of stdout.split('\n')) {
    const separator = line.lastIndexOf('｜')
    if (separator < 0) continue
    const candidate = line.slice(separator + 1)
    try { if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) found = candidate } catch { /* not a directory line */ }
  }
  return found
}

/** One critic the fleet may assign: its worker name and model family. */
export interface CriticCandidate {
  worker: string
  family: string
}

/** Parse `fleet critics --producer-family <family>`, skipping its title, an empty list, and stale rows. */
export function parseCriticCandidates(stdout: string): CriticCandidate[] {
  const lines = stdout.split('\n')
  const candidates: CriticCandidate[] = []
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '（无）' || trimmed.includes('过期')) continue
    const parts = trimmed.split('｜')
    const worker = parts[0]?.trim()
    const family = parts.map(part => part.trim()).find(part => part.startsWith('family='))?.slice('family='.length)
    if (worker && family) candidates.push({ worker, family })
  }
  return candidates
}

/** Check that the fleet has a fresh critic from a different family; the fleet's review chain still chooses the worker. */
export async function readCriticCandidates(bin: string, producerFamily: string, cwd: string,
  run: (bin: string, args: string[], cwd: string) => Promise<string>): Promise<CriticCandidate[]> {
  const stdout = await run(bin, ['critics', '--producer-family', producerFamily], cwd)
  const candidates = parseCriticCandidates(stdout)
  if (!candidates.length) throw new Error(`当前没有可派的不同家族评审者（生产族 ${producerFamily}）`)
  return candidates
}

interface DelegationStore {
  tickets: { get(id: string): Ticket | undefined; save(ticket: Ticket): void }
}

/** Register the worktree shared by a card and its delegation on the latest Ticket; the caller owns the transaction. */
export function recordFleetWorktree(host: { store: DelegationStore }, ticketId: string, id: string, worktree: string): void {
  const ticket = host.store.tickets.get(ticketId)
  if (!ticket || ticket.fleetWorktrees?.[id] === worktree) return
  host.store.tickets.save({ ...ticket, fleetWorktrees: { ...ticket.fleetWorktrees, [id]: worktree }, updatedAt: new Date().toISOString() })
}

/** Append this delegation on the latest Ticket; the caller owns the transaction. */
export function recordDelegation(host: { store: DelegationStore }, ticketId: string, delegation: Delegation): void {
  const ticket = host.store.tickets.get(ticketId)
  if (!ticket) return
  const delegations = [...(ticket.delegations ?? [])]
  const index = delegations.findIndex(item => item.id === delegation.id)
  if (index >= 0) delegations[index] = delegation
  else delegations.push(delegation)
  host.store.tickets.save({ ...ticket, delegations, updatedAt: new Date().toISOString() })
}
