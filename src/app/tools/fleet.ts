/** Restricted host-side fleet commands for one worker's ticket directory. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { liveTicket, type Delegation, type Ticket } from '../../core/index.ts'
import { startBackgroundJob } from '../../executor/background.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import { CliError } from '../../infra/commands.ts'
import { attributeRunDir, knownRunDirs, readCriticCandidates, readRunOutcome, recordDelegation, runDirFromStdout, type RunOutcome } from './fleet-delegation.ts'
import { tool, type Tool } from './tool.ts'

const commands = ['card', 'run', 'review', 'verdict', 'ls', 'status', 'critics'] as const
const token = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/
const chains = new Set(['code', 'complex', 'bulk', 'survey', 'zh-text', 'visual'])
const chainPattern = /^@[a-z][a-z-]*$/
const flags: Record<typeof commands[number], Record<string, boolean>> = {
  card: { '--title': true }, run: { '--role': true, '--timeout': true, '--dry-run': false },
  review: { '--critic': true, '--producer-family': true, '--base': true, '--timeout': true, '--dry-run': false },
  verdict: { '--note': true, '--self-fix-lines': true, '--self-run': false },
  ls: { '--all': false, '--open': false }, status: {}, critics: { '--producer-family': true },
}
/** Host-only options: the model may send them, but they are dropped so the host alone fills them. */
const hostOnly = new Set(['--critic', '--producer-family'])

/** Card facts the free-tier gate reads; an unreadable card is not a free one. */
function readCard(taskDir: string): { free: boolean; sensitivity?: string } {
  try {
    const lines = readFileSync(join(taskDir, 'card.md'), 'utf8').split(/\r?\n/).map(line => line.trim())
    const sensitivity = lines.map(line => /^- 材料敏感度[:：]\s*(.+)$/.exec(line)?.[1]?.trim()).find(Boolean)
    return { free: lines.includes('- 免费档：允许'), ...(sensitivity ? { sensitivity } : {}) }
  } catch { return { free: false } }
}

/** Validate all CLI operands before invoking Commands; no global options or passthrough flags are accepted. */
export function fleetArgv(argv: string[], directory: string): string[] {
  const [name, ...rest] = argv
  if (!commands.includes(name as typeof commands[number])) throw new Error('Fleet subcommand is not allowed')
  if (!isAbsolute(directory)) throw new Error('Ticket directory must be absolute')
  const root = realpathSync(directory)
  const command = name as typeof commands[number], positional: string[] = []
  const options = new Map<string, { value: string; inline: boolean }>()
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!
    if (value.includes('\0')) throw new Error('Invalid fleet argument')
    if (!value.startsWith('-')) { positional.push(value); continue }
    const [flag, inline] = value.split(/=(.*)/s)
    if (!Object.hasOwn(flags[command], flag!)) throw new Error(`Fleet option is not allowed: ${flag}`)
    const takesValue = flags[command][flag!]
    const argument = takesValue ? inline ?? rest[++i] : ''
    if (argument === undefined || argument.includes('\0') || (!takesValue && inline !== undefined)) throw new Error(`Invalid ${flag}`)
    if (command === 'review' && hostOnly.has(flag!)) continue
    if (options.has(flag!)) throw new Error(`Fleet option is not allowed: ${flag}`)
    options.set(flag!, { value: argument, inline: !!takesValue && inline !== undefined })
  }
  const expected = { card: 2, run: 2, review: 1, verdict: 2, ls: 1, status: 0, critics: 0 }[command]
  if (command === 'ls' && !positional.length) positional.push(directory)
  if (positional.length !== expected) throw new Error(`Invalid operands for fleet ${command}`)
  const project = command === 'card' || command === 'ls' ? positional[0] : undefined
  if (project !== undefined && project !== directory) throw new Error('Fleet project directory must equal the ticket directory')
  // Reject even in-project aliases: fleet derives its cwd from the resolved task's grandparents.
  if (command !== 'status' && command !== 'critics') {
    for (const part of [join(directory, '.fleet'), join(directory, '.fleet', 'tasks')]) {
      if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Fleet directories cannot be symlinks')
    }
  }
  const task = command === 'run' ? positional[1] : command === 'review' || command === 'verdict' ? positional[0] : undefined
  if (task !== undefined && (!isAbsolute(task) || dirname(task) !== join(directory, '.fleet', 'tasks') || realpathSync(task) !== join(root, '.fleet', 'tasks', basename(task)))) {
    throw new Error('Fleet task directory must belong to the ticket directory')
  }
  if (command === 'card' && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(positional[1]!)) throw new Error('Invalid fleet card slug')
  if (command === 'run' && (!chainPattern.test(positional[0]!) || !chains.has(positional[0]!.slice(1)))) {
    throw new Error('Fleet run takes only a chain type such as @code; do not name a worker (不要指名工人)')
  }
  if (command === 'card') {
    const title = options.get('--title')?.value
    if (title === undefined) throw new Error('Fleet card requires --title')
    if (!title.trim() || /[\r\n\0]/.test(title)) throw new Error('Invalid --title')
  }
  for (const flag of ['--critic', '--producer-family']) {
    const value = options.get(flag)?.value
    if (value !== undefined && !token.test(value)) throw new Error(`Invalid ${flag}`)
  }
  if (command === 'critics' && !options.has('--producer-family')) throw new Error('Missing fleet option')
  if (options.has('--base') && !/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/.test(options.get('--base')!.value)) throw new Error('Invalid review base')
  if (options.has('--role') && !['builder', 'reader', 'mass'].includes(options.get('--role')!.value)) throw new Error('Invalid fleet role')
  for (const flag of ['--timeout', '--self-fix-lines']) if (options.has(flag) && !/^\d+$/.test(options.get(flag)!.value)) throw new Error(`Invalid ${flag}`)
  if (command === 'verdict' && !['pass', 'rework', 'escalate', 'close'].includes(positional[1]!)) throw new Error('Invalid fleet verdict')
  // Rebuild so a stripped host-only option cannot survive, keeping positionals before options.
  const rebuilt = [name!, ...positional]
  for (const [flag, option] of options) {
    if (option.inline) rebuilt.push(`${flag}=${option.value}`)
    else { rebuilt.push(flag); if (flags[command][flag]) rebuilt.push(option.value) }
  }
  return rebuilt
}

/** Append options the host alone fills, such as the review chain type, to a validated argv. */
export function withHostFleetOptions(argv: string[], options: Record<string, string>): string[] {
  const result = [...argv]
  for (const [flag, value] of Object.entries(options)) result.push(flag, value)
  return result
}

const iso = (): string => new Date().toISOString()
const roleOf = (outcome: RunOutcome): Delegation['role'] =>
  outcome.role === 'reader' || outcome.role === 'mass' ? outcome.role : 'builder'

/** The fleet exit code carried by a failed command, as `fleet-exit-N`; `unknown` when the error carries none. */
function exitClass(error: unknown, captured?: number): string {
  const code = typeof captured === 'number'
    ? captured
    : Number(/\bexited with code (\d+)\b/.exec(String(error))?.[1]) || undefined
  return code === undefined ? 'unknown' : `fleet-exit-${code}`
}

/** Why an attributed run did not reach its terminal success state; never empty. */
function incompleteClass(outcome: RunOutcome): string {
  if (outcome.errorClass) return outcome.errorClass
  if (outcome.status !== 'done') return `status-${outcome.status || 'unknown'}`
  if (!outcome.reportExists) return 'missing-report'
  if (!outcome.worker && !outcome.family) return 'missing-identity'
  return 'incomplete-run'
}

/** Register only when enabled. Recheck the live switch and directory on every invocation. */
export function fleetTools(host: Pick<ResourceHost, 'store' | 'context' | 'commands'>,
  sessions: Pick<Sessions, 'prompt'>, ticket: Ticket, atomic: <T>(work: () => T) => T): Tool[] {
  if (!host.store.settings().executor.fleet.enabled) return []
  return [tool({
    name: 'orchestrator_fleet',
    description: 'Run fleet on the host with argv (subcommand first). Allowed: card/run/review/verdict/ls/status/critics. The run worker slot takes only a chain type (@code/@complex/@bulk/@survey/@zh-text/@visual); do not name a worker. The host arranges the critic from fleet evidence, so do not name a critic either. Project must be DSH_SUPERAGENT_DIR; task directories must be its .fleet/tasks/<id>. run/review return a background job immediately; completion wakes you. No shell, admission bypass or arbitrary flags.',
    schema: z.object({ argv: z.array(z.string().min(1)).min(1).max(32) }).strict(),
    execute: async ({ argv }, signal) => {
      signal.throwIfAborted()
      const config = host.store.settings().executor.fleet
      if (!config.enabled) throw new Error('Fleet is disabled')
      const current = host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || !current.execution) throw new Error('Fleet requires a live ticket directory')
      const directory = current.execution.directory, args = fleetArgv(argv, directory)
      const taskDir = args[0] === 'run' ? args[2]! : args[0] === 'review' || args[0] === 'verdict' ? args[1]! : undefined
      const id = taskDir === undefined ? '' : basename(taskDir)
      const startedAt = iso()
      if (args[0] === 'run') {
        const chain = args[1]!.slice(1)
        const allowed = new Set(config.allowedChains.map(value => value.replace(/^@/, '')))
        if (!allowed.has(chain)) throw new Error(`Fleet chain @${chain} is not allowed here; allowed chains: ${[...allowed].map(value => `@${value}`).join(', ') || '(none)'}`)
        const delegations = current.delegations ?? []
        // One delegation is one card: a slug is spent for this ticket, in any state, and a retry takes a new card.
        if (delegations.some(item => item.id === id)) {
          throw new Error(`This card (${id}) was already delegated on this ticket; start a new card with fleet card (换一张新卡) instead of reusing it`)
        }
        const open = delegations.find(item => item.state !== 'verdicted' && item.state !== 'failed')
        if (open) throw new Error(`This ticket already has an unreviewed delegation (${open.id}); wait for its verdict before delegating again`)
        if (delegations.length >= config.delegationsPerTicket) throw new Error(`This ticket has used all ${config.delegationsPerTicket} delegations; report rather than delegate again`)
        const card = readCard(taskDir!)
        if (card.free) {
          if (!config.allowFree) throw new Error('The card asks for the free tier, but executor.fleet.allowFree is off')
          if (!card.sensitivity || !config.freeMaterialSensitivity.includes(card.sensitivity)) {
            throw new Error(`The card asks for the free tier, but its material sensitivity (${card.sensitivity ?? 'missing'}) is not in executor.fleet.freeMaterialSensitivity`)
          }
        }
      }
      // The producer family comes only from the delegation's recorded meta; a review without it has no foreign family to pick.
      if (args[0] === 'review') {
        const existing = current.delegations?.find(item => item.id === id)
        if (!existing) throw new Error(`There is no delegation to review yet (还没有可评审的委派记录): ${id}`)
        const producerFamily = existing.producer?.family ?? ''
        if (!producerFamily) throw new Error(`The producer family is unknown; cannot arrange a foreign-family review (生产族未知): ${id}`)
        await readCriticCandidates(config.bin, producerFamily, directory,
          (bin, criticArgs, cwd) => host.commands.withSignal(signal).run(bin, criticArgs, cwd))
      }
      const finalArgs = args[0] === 'review' ? withHostFleetOptions(args, { '--critic': '@review' }) : args
      // A verdict may not jump an in-flight delegation, and a pass needs a completed foreign-family review already recorded.
      if (args[0] === 'verdict') {
        const existing = current.delegations?.find(item => item.id === id)
        if (!existing) throw new Error(`There is no delegation to rule on yet (还没有可裁定的委派记录): ${id}`)
        if (existing.state === 'running' || existing.state === 'reviewing') {
          throw new Error(`The delegation is still in flight; wait for it to finish before a verdict (委派未结束，不能裁定): ${id}`)
        }
        if (args[2] === 'pass' && (existing.state !== 'reviewed' || !existing.critic.family || existing.critic.family === existing.producer.family)) {
          throw new Error(`A pass requires a completed foreign-family review (异族评审尚未完成，不能裁定通过): ${id}`)
        }
      }
      if (args[0] !== 'run' && args[0] !== 'review') {
        const stdout = await host.commands.withSignal(signal).run(config.bin, finalArgs, directory)
        if (args[0] === 'verdict') {
          atomic(() => {
            const latest = host.store.tickets.get(ticket.id)
            const existing = latest?.delegations?.find(item => item.id === id)
            if (existing) recordDelegation(host, ticket.id, {
              ...existing, verdict: args[2] as Delegation['verdict'], state: 'verdicted', endedAt: iso(),
            })
          })
        }
        return { stdout }
      }
      const sessionId = workerSessionId(ticket.id)
      // Snapshot the runs that already exist, so completion can tell this dispatch's fresh run from a historical one.
      const known = knownRunDirs(taskDir!)
      if (args[0] === 'run') {
        atomic(() => {
          if (!host.store.tickets.get(ticket.id)) throw new Error('The ticket ended before the delegation could start')
          recordDelegation(host, ticket.id, {
            id, chain: args[1]!, taskDir: taskDir!, role: 'builder', jobId: '', state: 'running',
            producer: { worker: '', family: '' }, critic: { worker: '', family: '' }, reviewJobId: '',
            verdict: '' as Delegation['verdict'], reviewRounds: 0, errorClass: '', startedAt, endedAt: '',
          })
        })
      } else {
        atomic(() => {
          const latest = host.store.tickets.get(ticket.id)
          const existing = latest?.delegations?.find(item => item.id === id)
          if (!existing) throw new Error(`There is no delegation to review yet (还没有可评审的委派记录): ${id}`)
          recordDelegation(host, ticket.id, { ...existing, state: 'reviewing' })
        })
      }
      // Capture the fleet exit code from the original error here, before startBackgroundJob stringifies it.
      let exitCode: number | undefined
      const dispatch = async (stop: AbortSignal): Promise<string> => {
        try {
          return await host.commands.withSignal(stop).run(config.bin, finalArgs, directory, config.timeoutMinutes * 60_000)
        } catch (error) {
          exitCode = error instanceof CliError && typeof error.exitCode === 'number' ? error.exitCode : undefined
          throw error
        }
      }
      let jobId: string
      try {
        jobId = startBackgroundJob(host.context, sessionId, `fleet ${args[0]}`, dispatch,
          async (wakeId, result) => {
            const live = host.store.tickets.get(ticket.id)
            if (!live || !liveTicket(live)) return
            const stdout = result.stdout ?? ''
            const candidate = runDirFromStdout(stdout)
            const runDir = attributeRunDir(taskDir!, candidate, known)
            const outcome = runDir === undefined ? undefined : readRunOutcome(taskDir!, runDir)
            // A failed command loses stdout, so only its fleet exit code (or `unknown`) remains for the record.
            const failureClass = result.error !== undefined ? exitClass(result.error, exitCode)
              : candidate === undefined ? 'missing-run-dir' : 'unattributed-run'
            atomic(() => {
              const latest = host.store.tickets.get(ticket.id)
              if (!latest) return
              const previous = latest.delegations?.find(item => item.id === id)
              const note = stdout.includes('建议拆成阶段卡') ? 'fleet 建议拆成阶段卡' : previous?.note
              if (args[0] === 'run') {
                const reported = outcome !== undefined && outcome.status === 'done' && outcome.reportExists && outcome.family !== ''
                recordDelegation(host, ticket.id, {
                  id, chain: args[1]!, taskDir: taskDir!, role: outcome ? roleOf(outcome) : previous?.role ?? 'builder', jobId: wakeId,
                  state: reported ? 'reported' : 'failed',
                  producer: outcome
                    ? { worker: outcome.worker, family: outcome.family,
                      ...(outcome.routeId ? { routeId: outcome.routeId } : {}), ...(outcome.model ? { model: outcome.model } : {}) }
                    : { worker: '', family: '' },
                  critic: { worker: '', family: '' }, reviewJobId: '', verdict: '' as Delegation['verdict'],
                  reviewRounds: 0, errorClass: reported ? outcome.errorClass ?? '' : outcome ? incompleteClass(outcome) : failureClass,
                  ...(note ? { note } : {}), startedAt: previous?.startedAt ?? startedAt, endedAt: iso(),
                })
              } else {
                const producerFamily = previous?.producer?.family ?? ''
                const attributed = outcome !== undefined
                // Every attributed review attempt uses one round, whether it passes or not; an unattributed one uses none.
                const rounds = (previous?.reviewRounds ?? 0) + (attributed ? 1 : 0)
                const reviewed = attributed && outcome.status === 'done' && outcome.worker !== '' && outcome.family !== ''
                  && producerFamily !== '' && outcome.family !== producerFamily
                let errorClass = ''
                if (!reviewed) {
                  if (!producerFamily) errorClass = 'unknown-producer-family'
                  else if (!attributed) errorClass = failureClass
                  else if (outcome.status === 'done' && outcome.family === producerFamily) errorClass = 'same-family'
                  else errorClass = incompleteClass(outcome)
                }
                recordDelegation(host, ticket.id, {
                  id, chain: previous?.chain ?? 'review', taskDir: taskDir!, role: previous?.role ?? 'builder',
                  jobId: previous?.jobId ?? '', state: reviewed ? 'reviewed' : 'reported',
                  producer: previous?.producer ?? { worker: '', family: '' },
                  critic: reviewed ? { worker: outcome.worker, family: outcome.family } : { worker: '', family: '' },
                  reviewJobId: wakeId, verdict: previous?.verdict ?? '' as Delegation['verdict'], reviewRounds: rounds,
                  errorClass, ...(note ? { note } : {}), startedAt: previous?.startedAt ?? startedAt, endedAt: iso(),
                })
              }
            })
            await sessions.prompt(sessionId, wakeId, JSON.stringify({ kind: 'fleet_result', job_id: wakeId, ...result }), 'steer')
          })
      } catch (error) {
        // A placeholder must never stay in flight when the job could not start.
        atomic(() => {
          const latest = host.store.tickets.get(ticket.id)
          const existing = latest?.delegations?.find(item => item.id === id)
          if (existing) recordDelegation(host, ticket.id, { ...existing, state: 'failed', errorClass: exitClass(error, exitCode), endedAt: iso() })
        })
        throw error
      }
      return { job_id: jobId, status: 'running' }
    },
  })]
}
