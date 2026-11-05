/** Host fleet tool restrictions and lifecycle on the real Runtime with an isolated simulated DSH host. */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fleetArgv } from '../src/app/tools/fleet.ts'
import { runningJobs, stopBackground, untilQuiet } from '../src/executor/background.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

// Observe subprocess options while retaining real execFile execution for argv and timeout checks.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(vi.fn(actual.execFile), { [promisify.custom]: vi.fn(promisify(actual.execFile)) }) }
})

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

async function worker(enabled = true, bin = 'fleet', timeoutMinutes = 180) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, fleet: { ...settings.executor.fleet, enabled, bin, timeoutMinutes } } })
  const result = await h.acceptedTicket(feishu('1', '修复按钮'))
  const directory = result.ticket.execution!.directory, task = join(directory, '.fleet', 'tasks', 'test-card')
  mkdirSync(task, { recursive: true })
  return { ...result, directory, task, call: (argv: string[]) => h.runTool(result.sessionId, 'orchestrator_fleet', { argv }) }
}

it('defaults to disabled and never registers on a disabled worker or the main Session', async () => {
  expect(SettingsSchema.parse({}).executor.fleet).toEqual({ enabled: false, bin: 'fleet', timeoutMinutes: 180, reportMaxChars: 20000 })
  const { sessionId } = await worker(false)
  expect(h.tools.get(sessionId)?.has('orchestrator_fleet')).toBe(false)
  expect(h.tools.get(h.runtime.masterId)?.has('orchestrator_fleet')).toBe(false)
})

it('registers enabled workers and rechecks the switch at invocation time', async () => {
  const { call, directory } = await worker()
  const run = vi.mocked(Commands.prototype.run); run.mockClear()
  await call(['ls'])
  expect(run).toHaveBeenCalledWith('fleet', ['ls', directory], directory)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, fleet: { ...settings.executor.fleet, enabled: false } } })
  await expect(call(['status'])).rejects.toThrow('disabled')
  expect(run).toHaveBeenCalledTimes(1)
})

it.each(['reap', 'pool-clear', 'routing-page', 'selftest', 'bash', '--help'])('refuses non-allowlisted subcommand %s before execution', async command => {
  const { call } = await worker()
  const run = vi.mocked(Commands.prototype.run); run.mockClear()
  await expect(call([command])).rejects.toThrow('not allowed')
  expect(run).not.toHaveBeenCalled()
})

it('rejects project mismatches, external task directories, traversal, unknown flags and bypass flags', async () => {
  const { call, directory, task } = await worker()
  const run = vi.mocked(Commands.prototype.run); run.mockClear()
  for (const argv of [
    ['card', h.directory, 'escape'], ['ls', h.directory], ['ls', directory, '--project-dir', h.directory],
    ['run', '@complex', join(h.directory, '.fleet', 'tasks', 'other')],
    ['review', task + '/../test-card', '--critic', '@critic'], ['verdict', h.directory, 'pass'],
    ['run', '@complex', task, '--skip-admission'], ['review', task, '--critic', '@critic', '--skip-precheck'],
    ['card', directory, '../escape'], ['ls', '--', h.directory], ['status', directory],
  ]) await expect(call(argv)).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})

it('rejects symlink task escapes and symlink fleet roots', async () => {
  const { directory, task } = await worker()
  const alias = join(directory, '.fleet', 'tasks', 'alias')
  symlinkSync(h.directory, alias)
  expect(() => fleetArgv(['run', '@complex', alias], directory)).toThrow('ticket directory')
  const another = join(h.directory, 'another'); mkdirSync(another)
  symlinkSync(join(directory, '.fleet'), join(another, '.fleet'))
  expect(() => fleetArgv(['card', another, 'escape'], another)).toThrow('symlinks')
  expect(fleetArgv(['review', task, '--critic=@critic', '--base', 'HEAD~1'], directory)).toEqual(['review', task, '--critic=@critic', '--base', 'HEAD~1'])
})

it('passes literal argv through real Commands.execFile without shell expansion', async () => {
  const bin = join(h.directory, 'fleet fixture'), marker = join(h.directory, 'should-not-exist')
  writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 })
  const { call, directory } = await worker(true, bin)
  vi.mocked(Commands.prototype.run).mockRestore()
  const argv = ['card', directory, 'literal', '--title', `中文 spaces; $(touch '${marker}') \`touch '${marker}'\` & > file`]
  expect(JSON.parse(String((await call(argv)).stdout))).toEqual(argv)
  expect(existsSync(marker)).toBe(false)
  const exec = vi.mocked(promisify(execFile))
  expect(exec).toHaveBeenLastCalledWith(bin, argv, expect.objectContaining({ cwd: directory, timeout: 90_000 }))
  expect(exec.mock.calls.at(-1)![2]).not.toHaveProperty('shell')
  for (const args of [['ls'], ['status'], ['critics', '--producer-family', 'codex'], ['verdict', join(directory, '.fleet', 'tasks', 'test-card'), 'pass']]) {
    await call(args)
    expect(exec.mock.calls.at(-1)![2]).toMatchObject({ timeout: 90_000 })
  }
})

it('validates integer fleet timeout and report bounds and fills defaults in older fleet settings', () => {
  const parse = (fleet: Record<string, unknown>) => SettingsSchema.parse({ executor: { fleet } }).executor.fleet
  expect(parse({ enabled: true, bin: 'custom-fleet' })).toEqual({ enabled: true, bin: 'custom-fleet', timeoutMinutes: 180, reportMaxChars: 20000 })
  for (const value of [0, 601, 1.5]) expect(() => parse({ timeoutMinutes: value })).toThrow()
  for (const value of [999, 100001, 1000.5]) expect(() => parse({ reportMaxChars: value })).toThrow()
  expect(parse({ timeoutMinutes: 1, reportMaxChars: 1000 })).toMatchObject({ timeoutMinutes: 1, reportMaxChars: 1000 })
  expect(parse({ timeoutMinutes: 600, reportMaxChars: 100000 })).toMatchObject({ timeoutMinutes: 600, reportMaxChars: 100000 })
})

it('enforces a custom Commands timeout and reports actual seconds, including when stderr is present', async () => {
  vi.mocked(Commands.prototype.run).mockRestore()
  await expect(h.runtime.commands.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], h.directory, 50))
    .rejects.toThrow('timed out after 0.05 s')
  const timedOut = { killed: true, signal: 'SIGTERM', stderr: 'partial progress' }
  expect(commandError(timedOut, 'fleet', 7 * 60_000).message).toBe('fleet timed out after 420 s')
  expect(commandError(timedOut, 'fleet').message).toBe('fleet timed out after 90 s')
})

describe('background fleet commands', () => {
  it.each(['run', 'review'])('%s returns while still running and wakes the worker on completion', async command => {
    const { call, task, sessionId, directory } = await worker(true, 'fleet', 47)
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockReturnValue(pending.promise)
    const argv = command === 'run' ? ['run', '@complex', task] : ['review', task, '--critic', '@critic']
    const result = await call(argv)
    expect(result).toMatchObject({ status: 'running', job_id: expect.stringMatching(/^fleet-/) })
    expect(Commands.prototype.run).toHaveBeenCalledWith('fleet', argv, directory, 47 * 60_000)
    expect(runningJobs(h.ctx, sessionId).map(job => job.id)).toContain(result.job_id)
    const agent = h.agents.get(sessionId)!; agent.status = 'idle'
    const quiet = untilQuiet(h.ctx, agent as unknown as Agent, new AbortController().signal)
    pending.resolve('  completed\n原样输出\n')
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.sessionId === sessionId && d.text.includes('fleet_result'))).toBe(true))
    const text = h.deliveries.mock.calls.findLast(([d]) => d.sessionId === sessionId && d.text.includes('fleet_result'))![0].text
    expect(JSON.parse(text)).toEqual({ kind: 'fleet_result', job_id: result.job_id, status: 'completed', stdout: '  completed\n原样输出\n' })
    expect(await quiet).toBe(false)
    expect(runningJobs(h.ctx, sessionId)).toEqual([])
  })

  it('keeps fleet running after 30 idle minutes while expiring ordinary shell jobs, then wakes on completion', async () => {
    const { call, task, sessionId, ticket } = await worker(true, 'fleet', 47)
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockReturnValue(pending.promise)
    const signal = vi.spyOn(Commands.prototype, 'withSignal')
    const result = await call(['run', '@complex', task])
    const stopSignal = signal.mock.calls.at(-1)![0]!
    const shell = h.jobs.run(sessionId, 'ordinary shell job')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const agent = h.agents.get(sessionId)!; agent.status = 'idle'
      h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(stopSignal.aborted).toBe(false)
      expect(h.jobs.service.kill).toHaveBeenCalledWith(shell, sessionId, expect.any(String))
      expect(runningJobs(h.ctx, sessionId).map(job => job.id)).toEqual([result.job_id])
      expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toBeUndefined()
    } finally { pending.resolve('finished after 31 minutes'); vi.useRealTimers() }
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.sessionId === sessionId && d.text.includes('finished after 31 minutes'))).toBe(true))
    expect(runningJobs(h.ctx, sessionId)).toEqual([])
  })

  it('wakes on failure and stops host commands with the assignment without a completion wake', async () => {
    const { call, task, sessionId } = await worker()
    vi.mocked(Commands.prototype.run).mockRejectedValueOnce(new Error('fleet failed'))
    await call(['run', '@complex', task])
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.text.includes('fleet failed'))).toBe(true))
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockReturnValue(pending.promise)
    const signal = vi.spyOn(Commands.prototype, 'withSignal')
    await call(['run', '@complex', task])
    const stopSignal = signal.mock.calls.at(-1)![0]!
    h.deliveries.mockClear()
    const stopping = stopBackground(h.ctx, sessionId, 'assignment stopped')
    expect(stopSignal.aborted).toBe(true)
    pending.reject(new Error('aborted'))
    await stopping
    expect(runningJobs(h.ctx, sessionId)).toEqual([])
    expect(h.deliveries.mock.calls.some(([d]) => d.text.includes('fleet_result'))).toBe(false)
  })
})
