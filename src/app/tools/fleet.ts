/** Restricted host-side fleet commands for one worker's ticket directory. */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { liveTicket, type Ticket } from '../../core/index.ts'
import { startBackgroundJob } from '../../executor/background.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import { tool, type Tool } from './tool.ts'

const commands = ['card', 'run', 'review', 'verdict', 'ls', 'status', 'critics'] as const
const token = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/
const flags: Record<typeof commands[number], Record<string, boolean>> = {
  card: { '--title': true }, run: { '--role': true, '--timeout': true, '--dry-run': false },
  review: { '--critic': true, '--base': true, '--timeout': true, '--dry-run': false },
  verdict: { '--note': true, '--self-fix-lines': true, '--self-run': false },
  ls: { '--all': false, '--open': false }, status: {}, critics: { '--producer-family': true },
}

/** Validate all CLI operands before invoking Commands; no global options or passthrough flags are accepted. */
export function fleetArgv(argv: string[], directory: string): string[] {
  const [name, ...rest] = argv
  if (!commands.includes(name as typeof commands[number])) throw new Error('Fleet subcommand is not allowed')
  if (!isAbsolute(directory)) throw new Error('Ticket directory must be absolute')
  const root = realpathSync(directory)
  const command = name as typeof commands[number], positional: string[] = [], options = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!
    if (value.includes('\0')) throw new Error('Invalid fleet argument')
    if (!value.startsWith('-')) { positional.push(value); continue }
    const [flag, inline] = value.split(/=(.*)/s)
    if (!Object.hasOwn(flags[command], flag!) || options.has(flag!)) throw new Error(`Fleet option is not allowed: ${flag}`)
    const takesValue = flags[command][flag!]
    const argument = takesValue ? inline ?? rest[++i] : ''
    if (argument === undefined || argument.includes('\0') || (!takesValue && inline !== undefined)) throw new Error(`Invalid ${flag}`)
    options.set(flag!, argument)
  }
  const expected = { card: 2, run: 2, review: 1, verdict: 2, ls: 1, status: 0, critics: 0 }[command]
  if (command === 'ls' && !positional.length) { positional.push(directory); argv = [...argv, directory] }
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
  if (command === 'run' && !token.test(positional[0]!)) throw new Error('Invalid fleet worker')
  for (const flag of ['--critic', '--producer-family']) {
    if (options.has(flag) && !token.test(options.get(flag)!)) throw new Error(`Invalid ${flag}`)
  }
  if (command === 'review' && !options.has('--critic') || command === 'critics' && !options.has('--producer-family')) throw new Error('Missing fleet option')
  if (options.has('--base') && !/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/.test(options.get('--base')!)) throw new Error('Invalid review base')
  if (options.has('--role') && !['builder', 'reader', 'mass'].includes(options.get('--role')!)) throw new Error('Invalid fleet role')
  for (const flag of ['--timeout', '--self-fix-lines']) if (options.has(flag) && !/^\d+$/.test(options.get(flag)!)) throw new Error(`Invalid ${flag}`)
  if (command === 'verdict' && !['pass', 'rework', 'escalate', 'close'].includes(positional[1]!)) throw new Error('Invalid fleet verdict')
  return [...argv]
}

/** Register only when enabled. Recheck the live switch and directory on every invocation. */
export function fleetTools(host: Pick<ResourceHost, 'store' | 'context' | 'commands'>, sessions: Pick<Sessions, 'prompt'>, ticket: Ticket): Tool[] {
  if (!host.store.settings().executor.fleet.enabled) return []
  return [tool({
    name: 'orchestrator_fleet',
    description: 'Run fleet on the host with argv (subcommand first). Allowed: card/run/review/verdict/ls/status/critics. Project must be DSH_SUPERAGENT_DIR; task directories must be its .fleet/tasks/<id>. run/review return a background job immediately; completion wakes you. No shell, admission bypass or arbitrary flags.',
    schema: z.object({ argv: z.array(z.string().min(1)).min(1).max(32) }).strict(),
    execute: async ({ argv }, signal) => {
      signal.throwIfAborted()
      const config = host.store.settings().executor.fleet
      if (!config.enabled) throw new Error('Fleet is disabled')
      const current = host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || !current.execution) throw new Error('Fleet requires a live ticket directory')
      const directory = current.execution.directory, args = fleetArgv(argv, directory)
      if (args[0] !== 'run' && args[0] !== 'review') return { stdout: await host.commands.withSignal(signal).run(config.bin, args, directory) }
      const sessionId = workerSessionId(ticket.id)
      const jobId = startBackgroundJob(host.context, sessionId, `fleet ${args[0]}`,
        stop => host.commands.withSignal(stop).run(config.bin, args, directory, config.timeoutMinutes * 60_000),
        async (id, result) => {
          const live = host.store.tickets.get(ticket.id)
          if (live && liveTicket(live)) await sessions.prompt(sessionId, id, JSON.stringify({ kind: 'fleet_result', job_id: id, ...result }), 'steer')
        })
      return { job_id: jobId, status: 'running' }
    },
  })]
}
