/** Restricted host-side fleet commands for one worker's ticket directory. */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { liveTicket, type Delegation, type Ticket } from '../../core/index.ts'
import { startBackgroundJob } from '../../executor/background.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import { CliError } from '../../infra/commands.ts'
import { attributeRunDir, knownRunDirs, readCriticCandidates, readReviewConclusion, readRunOutcome, recordDelegation, recordFleetWorktree, runDirFromStdout, type RunOutcome } from './fleet-delegation.ts'
import { assertFleetCard, readFleetCard } from './fleet-card.ts'
import { ensureFleetWorktree } from './fleet-worktree.ts'
import { tool, type Tool } from './tool.ts'

const commands = ['card', 'run', 'review', 'verdict', 'ls', 'status', 'critics'] as const
const token = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/
const chains = new Set(['code', 'complex', 'bulk', 'survey', 'zh-text', 'visual'])
const chainPattern = /^@[a-z][a-z-]*$/
const flags: Record<typeof commands[number], Record<string, boolean>> = {
  card: { '--title': true }, run: { '--role': true, '--timeout': true, '--dry-run': false },
  review: { '--critic': true, '--producer-family': true, '--base': true, '--timeout': true, '--dry-run': false },
  verdict: { '--note': true, '--self-fix-lines': true, '--self-run': false, '--override-reason': true },
  ls: { '--all': false, '--open': false }, status: {}, critics: { '--producer-family': true },
}
/** Host-only options: the model may send them, but they are dropped so the host alone fills them. */
const hostOnly = new Set(['--critic', '--producer-family'])

/** Validate all CLI operands before invoking Commands; no global options or passthrough flags are accepted. */
export function fleetArgv(argv: string[], directory: string, worktree?: string): string[] {
  const [name, ...rest] = argv
  if (!commands.includes(name as typeof commands[number])) throw new Error('Fleet subcommand is not allowed')
  if (!isAbsolute(directory)) throw new Error('Ticket directory must be absolute')
  const roots = worktree ? [directory, worktree] : [directory]
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
  if (project !== undefined && !roots.includes(project)) throw new Error('Fleet project directory must equal the ticket directory or its registered worktree')
  // Reject even in-project aliases: fleet derives its cwd from the resolved task's grandparents.
  if (command !== 'status' && command !== 'critics') {
    for (const base of roots) for (const part of [join(base, '.fleet'), join(base, '.fleet', 'tasks')]) {
      if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Fleet directories cannot be symlinks')
    }
  }
  const taskIndex = command === 'run' ? 1 : command === 'review' || command === 'verdict' ? 0 : undefined
  const task = taskIndex === undefined ? undefined : positional[taskIndex]
  const validTask = task !== undefined && isAbsolute(task) && roots.some(base => dirname(task) === join(base, '.fleet', 'tasks')
    && realpathSync(task) === join(realpathSync(base), '.fleet', 'tasks', basename(task)))
  if (task !== undefined && !validTask) throw new Error('Fleet task directory must belong to the ticket directory or its registered worktree')
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
  const overrideReason = options.get('--override-reason')?.value
  if (overrideReason !== undefined && (!overrideReason.trim() || /[\r\n\0]/.test(overrideReason))) throw new Error('Invalid --override-reason')
  if (command === 'verdict' && !['pass', 'rework', 'escalate', 'close'].includes(positional[1]!)) throw new Error('Invalid fleet verdict')
  if (worktree && ['card', 'run', 'review', 'verdict'].includes(command)) {
    if (command === 'card') positional[0] = worktree
    if (task !== undefined && taskIndex !== undefined) positional[taskIndex] = join(worktree, '.fleet', 'tasks', basename(task))
  }
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

/** Read the override from canonical verdict argv without mistaking another option's value for a flag. */
function verdictOverrideReason(argv: string[]): string | undefined {
  for (let i = 3; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split(/=(.*)/s)
    const value = flags.verdict[flag!] ? inline ?? argv[++i] : undefined
    if (flag === '--override-reason') return value
  }
  return undefined
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

/** Why a delegation in this state cannot start a review; each state has its own searchable message. */
function reviewStateError(state: Delegation['state'], id: string): Error {
  switch (state) {
    case 'running': return new Error(`The delegation is still running; wait for it to finish before reviewing (委派尚未完成): ${id}`)
    case 'reviewing': return new Error(`A review is already in flight; do not start a second review (评审已在飞，不得重复发起评审): ${id}`)
    case 'reviewed': return new Error(`This delegation was already reviewed and waits for a verdict (已评审，等待裁定): ${id}`)
    case 'verdicted': return new Error(`This delegation already has a verdict; start a new card to delegate again (已裁定，要重派请换一张新卡): ${id}`)
    case 'failed': return new Error(`This delegation failed and has no output to review (该委派失败，没有可评审的产出): ${id}`)
    case 'not-started': return new Error(`This delegation has not started and has no output to review; retry the same card (尚未开始，没有可评审的产出): ${id}`)
    default: return new Error(`This delegation is not reviewable in state ${state} (该状态不能发起评审): ${id}`)
  }
}

/** Register only when enabled. Recheck the live switch and directory on every invocation. */
export function fleetTools(host: Pick<ResourceHost, 'store' | 'context' | 'commands'>,
  sessions: Pick<Sessions, 'prompt'>, ticket: Ticket, atomic: <T>(work: () => T) => T): Tool[] {
  if (!host.store.settings().executor.fleet.enabled) return []
  return [tool({
    name: 'orchestrator_fleet',
    description: 'Run fleet on the host with argv (subcommand first). Allowed: card/run/review/verdict/ls/status/critics. The run worker slot takes only a chain type (@code/@complex/@bulk/@survey/@zh-text/@visual); do not name a worker. The host arranges the critic from fleet evidence, so do not name a critic either. Project must be DSH_SUPERAGENT_DIR or its registered worktree; task directories must be .fleet/tasks/<id> under it. run/review return a background job immediately; completion wakes you. No shell, admission bypass or arbitrary flags.',
    schema: z.object({ argv: z.array(z.string().min(1)).min(1).max(32) }).strict(),
    execute: async ({ argv }, signal) => {
      signal.throwIfAborted()
      const config = host.store.settings().executor.fleet
      if (!config.enabled) throw new Error('Fleet is disabled')
      const current = host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || !current.execution) throw new Error('Fleet requires a live ticket directory')
      const directory = current.execution.directory
      const requestedTask = argv[0] === 'run' ? argv[2] : argv[0] === 'review' || argv[0] === 'verdict' ? argv[1] : undefined
      const requestedId = argv[0] === 'card' ? argv[2] : requestedTask ? basename(requestedTask) : undefined
      const recorded = requestedId ? current.delegations?.find(item => item.id === requestedId) : undefined
      let worktree = recorded?.worktree ?? (requestedId ? current.fleetWorktrees?.[requestedId] : undefined)
      let args = fleetArgv(argv, directory, worktree)
      const isolate = async (id: string): Promise<void> => {
        if (worktree) return
        worktree = await ensureFleetWorktree(directory, id,
          (program, gitArgs, cwd) => host.commands.withSignal(signal).run(program, gitArgs, cwd))
        if (worktree) {
          atomic(() => recordFleetWorktree(host, ticket.id, id, worktree!))
          args = fleetArgv(argv, directory, worktree)
        }
      }
      if (args[0] === 'card') await isolate(args[2]!)
      let taskDir = args[0] === 'run' ? args[2]! : args[0] === 'review' || args[0] === 'verdict' ? args[1]! : undefined
      const id = taskDir === undefined ? '' : basename(taskDir)
      const startedAt = iso()
      // Every transition into an in-flight state uses this admission check inside its placeholder transaction.
      const checkConcurrency = () => {
        const inFlight = host.store.tickets.list().flatMap(item => item.delegations ?? [])
          .filter(item => item.state === 'running' || item.state === 'reviewing').length
        if (inFlight >= config.maxConcurrent) {
          throw new Error(`Fleet concurrent delegation limit reached: ${inFlight}/${config.maxConcurrent} in flight; wait for a delegation to finish before starting another delegation or review`)
        }
      }
      const reviewAdmission = (latest: Ticket | undefined): Delegation => {
        const existing = latest?.delegations?.find(item => item.id === id)
        if (!existing) throw new Error(`There is no delegation to review yet (还没有可评审的委派记录): ${id}`)
        // Spend no subprocess on critics once the host-side round budget is used up.
        if (existing.reviewRounds >= config.reviewRounds) {
          throw new Error(`Review rounds exhausted (评审轮数已用尽): ${existing.reviewRounds}/${config.reviewRounds}; report escalate to a person (交人工 / escalate) instead of starting another review`)
        }
        if (existing.state !== 'reported') throw reviewStateError(existing.state, id)
        const producerFamily = existing.producer?.family ?? ''
        if (!producerFamily) throw new Error(`The producer family is unknown; cannot arrange a foreign-family review (生产族未知): ${id}`)
        checkConcurrency()
        return existing
      }
      if (args[0] === 'run') {
        const chain = args[1]!.slice(1)
        const allowed = new Set(config.allowedChains.map(value => value.replace(/^@/, '')))
        if (!allowed.has(chain)) throw new Error(`Fleet chain @${chain} is not allowed here; allowed chains: ${[...allowed].map(value => `@${value}`).join(', ') || '(none)'}`)
        // Validate the actual card before Git worktree setup or any fleet subprocess; the host never rewrites it.
        assertFleetCard(readFleetCard(taskDir!), chain, config)
        await isolate(id)
        taskDir = args[2]!
      }
      // The producer family comes only from the delegation's recorded meta; a review without it has no foreign family to pick.
      if (args[0] === 'review') {
        // Check capacity before critic discovery; the placeholder transaction repeats it after the await.
        const existing = atomic(() => reviewAdmission(host.store.tickets.get(ticket.id)))
        await readCriticCandidates(config.bin, existing.producer.family, worktree ?? directory,
          (bin, criticArgs, cwd) => host.commands.withSignal(signal).run(bin, criticArgs, cwd))
      }
      const finalArgs = args[0] === 'review' ? withHostFleetOptions(args, { '--critic': '@review' }) : args
      const overrideReason = args[0] === 'verdict' ? verdictOverrideReason(args) : undefined
      // A verdict may not jump an in-flight delegation, and a pass needs a completed foreign-family review already recorded.
      if (args[0] === 'verdict') {
        const existing = current.delegations?.find(item => item.id === id)
        if (!existing) throw new Error(`There is no delegation to rule on yet (还没有可裁定的委派记录): ${id}`)
        if (existing.state === 'running' || existing.state === 'reviewing') {
          throw new Error(`The delegation is still in flight; wait for it to finish before a verdict (委派未结束，不能裁定): ${id}`)
        }
        if (args[2] === 'pass') {
          if (existing.state !== 'reviewed' || !existing.critic.family || existing.critic.family === existing.producer.family) {
            throw new Error(`A pass requires a completed foreign-family review (异族评审尚未完成，不能裁定通过): ${id}`)
          }
          const conclusion = existing.reviewConclusion ?? 'unknown'
          if (conclusion === 'unknown') {
            throw new Error(`A pass requires a readable review conclusion; unknown cannot be overridden (评审没有结论行，不能裁定通过): ${id}`)
          }
          if (conclusion === 'rework' && overrideReason === undefined) {
            throw new Error(`The review requires rework; pass needs an evidence-based --override-reason (评审要求返工，强行通过必须给出 override 理由): ${id}`)
          }
        }
        if (args[2] !== 'pass' && !['reported', 'reviewed', 'failed'].includes(existing.state)) {
          throw new Error(`A ${args[2]} verdict needs a delegation that reported, was reviewed, or failed (该状态不能记录裁定): ${id}`)
        }
      }
      const cwd = ['card', 'run', 'review', 'verdict'].includes(args[0]!) ? worktree ?? directory : directory
      if (args[0] !== 'run' && args[0] !== 'review') {
        const stdout = await host.commands.withSignal(signal).run(config.bin, finalArgs, cwd)
        if (args[0] === 'verdict') {
          atomic(() => {
            const latest = host.store.tickets.get(ticket.id)
            const existing = latest?.delegations?.find(item => item.id === id)
            if (existing) recordDelegation(host, ticket.id, {
              ...existing, verdict: args[2] as Delegation['verdict'], state: 'verdicted', endedAt: iso(),
              ...(args[2] === 'pass' && overrideReason !== undefined ? { overrideReason } : {}),
            })
          })
        }
        return { stdout, ...(worktree ? { worktree } : {}) }
      }
      const sessionId = workerSessionId(ticket.id)
      // Snapshot the runs that already exist, so completion can tell this dispatch's fresh run from a historical one.
      const known = knownRunDirs(taskDir!)
      if (args[0] === 'run') {
        atomic(() => {
          const latest = host.store.tickets.get(ticket.id)
          if (!latest) throw new Error('The ticket ended before the delegation could start')
          const delegations = latest.delegations ?? []
          const previous = delegations.find(item => item.id === id)
          // A card that never started may be retried twice in total; every other slug is spent and needs a new card.
          if (previous?.state === 'not-started' && (previous.attempts ?? 1) >= 2) {
            throw new Error(`This card (${id}) was not started after ${previous.attempts ?? 1} attempts; escalate to a person (升级交人工) instead of running it again`)
          }
          if (previous && previous.state !== 'not-started') {
            throw new Error(`This card (${id}) was already delegated on this ticket; start a new card with fleet card (换一张新卡) instead of reusing it`)
          }
          const open = delegations.find(item => item.state !== 'verdicted' && item.state !== 'failed' && item.state !== 'not-started')
          if (open) throw new Error(`This ticket already has an unreviewed delegation (${open.id}); wait for its verdict before delegating again`)
          const spent = delegations.filter(item => item.state !== 'not-started').length
          if (spent >= config.delegationsPerTicket) throw new Error(`This ticket has used all ${config.delegationsPerTicket} delegations; report rather than delegate again`)
          // Admission and the placeholder are one synchronous transaction: no competing dispatch can pass between them.
          checkConcurrency()
          recordDelegation(host, ticket.id, {
            id, chain: args[1]!, taskDir: taskDir!, ...(worktree ? { worktree } : {}), role: previous?.role ?? 'builder', jobId: '', state: 'running',
            attempts: previous ? (previous.attempts ?? 1) + 1 : 1,
            producer: { worker: '', family: '' }, critic: { worker: '', family: '' }, reviewJobId: '',
            verdict: '' as Delegation['verdict'], reviewRounds: 0, errorClass: '', startedAt, endedAt: '',
          })
        })
      } else {
        atomic(() => {
          // Revalidate everything after critic discovery: another delegation may have claimed the last slot meanwhile.
          const existing = reviewAdmission(host.store.tickets.get(ticket.id))
          // Clear the previous attempt's job id here: the retry owns the record now, and the binding below only
          // writes into an empty slot, so a stale id would leave the new job unbound and its callback rejected.
          recordDelegation(host, ticket.id, { ...existing, state: 'reviewing', reviewJobId: '' })
        })
      }
      // Capture the fleet exit code from the original error here, before startBackgroundJob stringifies it.
      let exitCode: number | undefined
      const dispatch = async (stop: AbortSignal): Promise<string> => {
        try {
          return await host.commands.withSignal(stop).run(config.bin, finalArgs, cwd, config.timeoutMinutes * 60_000)
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
            const reviewConclusion = args[0] === 'review' ? readReviewConclusion(taskDir!) : undefined
            // A failed command loses stdout, so only its fleet exit code (or `unknown`) remains for the record.
            const failureClass = result.error !== undefined ? exitClass(result.error, exitCode)
              : candidate === undefined ? 'missing-run-dir' : 'unattributed-run'
            const notStarted = args[0] === 'run' && result.error !== undefined && failureClass === 'fleet-exit-3'
            atomic(() => {
              const latest = host.store.tickets.get(ticket.id)
              if (!latest) return
              const previous = latest.delegations?.find(item => item.id === id)
              const note = stdout.includes('建议拆成阶段卡') ? 'fleet 建议拆成阶段卡' : previous?.note
              if (args[0] === 'run') {
                const reported = outcome !== undefined && outcome.status === 'done' && outcome.reportExists && outcome.family !== ''
                recordDelegation(host, ticket.id, {
                  id, chain: args[1]!, taskDir: taskDir!, ...(worktree ? { worktree } : {}), role: !notStarted && outcome ? roleOf(outcome) : previous?.role ?? 'builder', jobId: wakeId,
                  state: notStarted ? 'not-started' : reported ? 'reported' : 'failed', attempts: previous?.attempts ?? 1,
                  producer: !notStarted && outcome
                    ? { worker: outcome.worker, family: outcome.family,
                      ...(outcome.routeId ? { routeId: outcome.routeId } : {}), ...(outcome.model ? { model: outcome.model } : {}) }
                    : { worker: '', family: '' },
                  critic: { worker: '', family: '' }, reviewJobId: '', verdict: '' as Delegation['verdict'],
                  reviewRounds: 0, errorClass: notStarted ? failureClass : reported ? outcome.errorClass ?? '' : outcome ? incompleteClass(outcome) : failureClass,
                  ...(notStarted ? { note: '尚未开始，可以重试同一张卡' } : note ? { note } : {}),
                  startedAt: previous?.startedAt ?? startedAt, endedAt: iso(),
                })
              } else {
                // Only the job that owns this record may advance it; a superseded callback still wakes the worker below.
                if (!previous || previous.reviewJobId !== wakeId) return
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
                  id, chain: previous?.chain ?? 'review', taskDir: taskDir!, ...(worktree ? { worktree } : {}), role: previous?.role ?? 'builder',
                  jobId: previous?.jobId ?? '', state: reviewed ? 'reviewed' : 'reported', attempts: previous?.attempts ?? 1,
                  producer: previous?.producer ?? { worker: '', family: '' },
                  critic: reviewed ? { worker: outcome.worker, family: outcome.family } : { worker: '', family: '' },
                  reviewJobId: wakeId, reviewConclusion: reviewConclusion ?? 'unknown',
                  verdict: previous?.verdict ?? '' as Delegation['verdict'], reviewRounds: rounds,
                  errorClass, ...(note ? { note } : {}), startedAt: previous?.startedAt ?? startedAt, endedAt: iso(),
                })
              }
            })
            await sessions.prompt(sessionId, wakeId, JSON.stringify({ kind: 'fleet_result', job_id: wakeId, ...result }), 'steer')
          })
      } catch (error) {
        // A placeholder must never stay in flight when the job could not start.
        const failureClass = exitClass(error, error instanceof CliError ? error.exitCode : exitCode)
        const notStarted = args[0] === 'run' && failureClass === 'fleet-exit-3'
        atomic(() => {
          const latest = host.store.tickets.get(ticket.id)
          const existing = latest?.delegations?.find(item => item.id === id)
          if (existing) recordDelegation(host, ticket.id, { ...existing, state: notStarted ? 'not-started' : 'failed', errorClass: failureClass,
            ...(notStarted ? { note: '尚未开始，可以重试同一张卡' } : {}), endedAt: iso() })
        })
        throw error
      }
      // Bind the review to its job here, synchronously: no wait may separate the job start from this write.
      if (args[0] === 'review') {
        atomic(() => {
          const latest = host.store.tickets.get(ticket.id)
          const existing = latest?.delegations?.find(item => item.id === id)
          if (existing && existing.state === 'reviewing' && !existing.reviewJobId) {
            recordDelegation(host, ticket.id, { ...existing, reviewJobId: jobId })
          }
        })
      }
      return { job_id: jobId, status: 'running', ...(worktree ? { worktree } : {}) }
    },
  })]
}
