/** Host fleet tool restrictions and lifecycle on the real Runtime with an isolated simulated DSH host. */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fleetArgv } from '../src/app/tools/fleet.ts'
import { runningJobs, stopBackground, untilQuiet } from '../src/executor/background.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Delegation } from '../src/core/model.ts'
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
  expect(SettingsSchema.parse({}).executor.fleet).toEqual({ enabled: false, bin: 'fleet', timeoutMinutes: 180, reportMaxChars: 20000, allowedChains: ['code', 'complex'], delegationsPerTicket: 2, reviewRounds: 3, allowFree: false, freeMaterialSensitivity: [] })
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
  expect(fleetArgv(['review', task, '--critic=@critic', '--base', 'HEAD~1'], directory)).toEqual(['review', task, '--base', 'HEAD~1'])
})

it('passes literal argv through real Commands.execFile without shell expansion', async () => {
  const bin = join(h.directory, 'fleet fixture'), marker = join(h.directory, 'should-not-exist')
  writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 })
  const { call, directory, ticket } = await worker(true, bin)
  vi.mocked(Commands.prototype.run).mockRestore()
  const argv = ['card', directory, 'literal', '--title', `中文 spaces; $(touch '${marker}') \`touch '${marker}'\` & > file`]
  expect(JSON.parse(String((await call(argv)).stdout))).toEqual(argv)
  expect(existsSync(marker)).toBe(false)
  const exec = vi.mocked(promisify(execFile))
  expect(exec).toHaveBeenLastCalledWith(bin, argv, expect.objectContaining({ cwd: directory, timeout: 90_000 }))
  expect(exec.mock.calls.at(-1)![2]).not.toHaveProperty('shell')
  const current = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...current, delegations: [{
    id: 'test-card', chain: '@complex', taskDir: join(directory, '.fleet', 'tasks', 'test-card'), role: 'builder',
    jobId: 'fleet-0', state: 'reviewed', producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' },
    critic: { worker: 'codex', family: 'gpt' }, reviewJobId: 'fleet-1', reviewConclusion: 'pass',
    verdict: '' as Delegation['verdict'], reviewRounds: 1, errorClass: '', startedAt: 'now', endedAt: 'now',
  }] })
  for (const args of [['ls'], ['status'], ['critics', '--producer-family', 'codex'], ['verdict', join(directory, '.fleet', 'tasks', 'test-card'), 'pass']]) {
    await call(args)
    expect(exec.mock.calls.at(-1)![2]).toMatchObject({ timeout: 90_000 })
  }
})

it('validates integer fleet timeout and report bounds and fills defaults in older fleet settings', () => {
  const parse = (fleet: Record<string, unknown>) => SettingsSchema.parse({ executor: { fleet } }).executor.fleet
  expect(parse({ enabled: true, bin: 'custom-fleet' })).toEqual({ enabled: true, bin: 'custom-fleet', timeoutMinutes: 180, reportMaxChars: 20000, allowedChains: ['code', 'complex'], delegationsPerTicket: 2, reviewRounds: 3, allowFree: false, freeMaterialSensitivity: [] })
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
    const { call, task, sessionId, directory, ticket } = await worker(true, 'fleet', 47)
    if (command === 'review') {
      const current = h.runtime.store.tickets.get(ticket.id)!
      h.runtime.store.tickets.save({ ...current, delegations: [{
        id: 'test-card', chain: '@complex', taskDir: task, role: 'builder', jobId: 'fleet-0', state: 'reported',
        producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' }, critic: { worker: '', family: '' }, reviewJobId: '',
        verdict: '' as Delegation['verdict'], reviewRounds: 0, errorClass: '', startedAt: 'now', endedAt: 'now',
      }] })
    }
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockImplementation((_bin, args) =>
      args[0] === 'critics' ? Promise.resolve('评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok') : pending.promise)
    const argv = command === 'run' ? ['run', '@complex', task] : ['review', task, '--critic', '@critic']
    const expected = command === 'run' ? argv : ['review', task, '--critic', '@review']
    const result = await call(argv)
    expect(result).toMatchObject({ status: 'running', job_id: expect.stringMatching(/^fleet-/) })
    expect(Commands.prototype.run).toHaveBeenCalledWith('fleet', expected, directory, 47 * 60_000)
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
    const { call, task, sessionId, directory } = await worker()
    vi.mocked(Commands.prototype.run).mockRejectedValueOnce(new Error('fleet failed'))
    await call(['run', '@complex', task])
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.text.includes('fleet failed'))).toBe(true))
    // A card slug is spent: a second delegation on this ticket needs a new card.
    const next = join(directory, '.fleet', 'tasks', 'test-card-2'); mkdirSync(next, { recursive: true })
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockReturnValue(pending.promise)
    const signal = vi.spyOn(Commands.prototype, 'withSignal')
    await call(['run', '@complex', next])
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

describe('delegation placeholders, attribution and review prechecks', () => {
  const recorded = (patch: Partial<Delegation>): Delegation => ({
    id: 'test-card', chain: '@complex', taskDir: '/tmp/test-card', role: 'builder', jobId: 'fleet-0', state: 'reported',
    producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' }, critic: { worker: '', family: '' }, reviewJobId: '',
    verdict: '' as Delegation['verdict'], reviewRounds: 0, errorClass: '', startedAt: 'now', endedAt: 'now', ...patch,
  })
  const seed = (ticketId: string, patch: Partial<Delegation> = {}) => {
    const current = h.runtime.store.tickets.get(ticketId)!
    h.runtime.store.tickets.save({ ...current, delegations: [recorded(patch)] })
  }

  it('writes the running placeholder before the command starts and refuses a reused card', async () => {
    const { call, task, ticket } = await worker()
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockReturnValue(pending.promise)
    expect(await call(['run', '@complex', task])).toMatchObject({ status: 'running' })
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations).toMatchObject([{
      id: 'test-card', state: 'running', role: 'builder', jobId: '', producer: { worker: '', family: '' },
      critic: { worker: '', family: '' }, reviewRounds: 0, errorClass: '', endedAt: '',
    }])
    await expect(call(['run', '@complex', task])).rejects.toThrow(/新卡/)
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations).toHaveLength(1)
    pending.resolve('done｜1.00 秒｜report.md 无｜')
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)?.state).toBe('failed'))
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({
      producer: { worker: '', family: '' }, errorClass: 'missing-run-dir',
    })
  })

  it('refuses a review with no candidate and leaves the delegation reported', async () => {
    const { call, task, ticket, directory, sessionId } = await worker()
    seed(ticket.id)
    vi.mocked(Commands.prototype.run).mockResolvedValue('评审证据（生产族 moonshot）：\n（无）')
    await expect(call(['review', task])).rejects.toThrow('当前没有可派的不同家族评审者')
    expect(Commands.prototype.run).toHaveBeenCalledWith('fleet', ['critics', '--producer-family', 'moonshot'], directory)
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reported' })
    expect(runningJobs(h.ctx, sessionId)).toEqual([])
  })

  it('refuses a review whose producer family is unknown', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { producer: { worker: '', family: '' } })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['review', task])).rejects.toThrow('生产族')
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reported' })
  })

  it('records a failed review by exit code without borrowing a historical run or spending a round', async () => {
    const { call, task, ticket, directory } = await worker()
    seed(ticket.id)
    const historical = join(task, 'runs', '20261105-230000-codex-builder'); mkdirSync(historical, { recursive: true })
    writeFileSync(join(historical, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', report_exists: true }))
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) => {
      if (args[0] === 'critics') return '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok'
      throw new Error('fleet exited with code 4')
    })
    await call(['review', task])
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.text.includes('fleet_result'))).toBe(true))
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({
      state: 'reported', producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' },
      critic: { worker: '', family: '' }, reviewRounds: 0, errorClass: 'fleet-exit-4',
    })
    expect(Commands.prototype.run).toHaveBeenCalledWith('fleet', ['critics', '--producer-family', 'moonshot'], directory)
  })

  it('refuses a review at the round cap without a command or any record change', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { reviewRounds: h.runtime.store.settings().executor.fleet.reviewRounds })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['review', task])).rejects.toThrow(/评审轮数已用尽/)
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reported', reviewRounds: 3 })
    expect(runningJobs(h.ctx, `worker-${ticket.id}`)).toEqual([])
  })

  it('binds the review record to its job and refuses a concurrent second review', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) =>
      args[0] === 'critics' ? '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok' : pending.promise)
    const first = await call(['review', task])
    expect(first).toMatchObject({ status: 'running' })
    const record = () => h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: first.job_id })
    await expect(call(['review', task])).rejects.toThrow(/评审已在飞|不得重复/)
    expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: first.job_id })
    const runDir = join(task, 'runs', '20261106-120000-codex-critic'); mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', role: 'critic', report_exists: true }))
    pending.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
    await vi.waitFor(() => expect(record()?.state).toBe('reviewed'))
    expect(record()).toMatchObject({ critic: { worker: 'codex', family: 'gpt' }, reviewRounds: 1 })
  })

  it.each([
    { conclusion: 'pass', review: '## 结论：通过\n' },
    { conclusion: 'rework', review: '## 结论：需返工\n' },
    { conclusion: 'unknown', review: undefined },
  ])('records $conclusion from review.md when the review job finishes', async ({ conclusion, review }) => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    if (review !== undefined) writeFileSync(join(task, 'review.md'), review)
    const pending = Promise.withResolvers<string>()
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) =>
      args[0] === 'critics' ? '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok' : pending.promise)
    await call(['review', task])
    const runDir = join(task, 'runs', '20261108-120000-codex-critic'); mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', role: 'critic', report_exists: true }))
    pending.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
    const record = () => h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    await vi.waitFor(() => expect(record()?.state).toBe('reviewed'))
    expect(record()).toMatchObject({ reviewConclusion: conclusion })
  })

  it('retries a failed review and binds the retry to its own job', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    const retry = Promise.withResolvers<string>()
    let reviews = 0
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) => {
      if (args[0] === 'critics') return '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok'
      reviews += 1
      if (reviews === 1) throw new Error('fleet exited with code 4')
      return retry.promise
    })
    const record = () => h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    await call(['review', task])
    expect(record()).toMatchObject({ state: 'reviewing' })
    // The failed attempt returns the delegation to reported and keeps the job id it ran under.
    await vi.waitFor(() => expect(record()?.state).toBe('reported'))
    expect(record()).toMatchObject({ errorClass: 'fleet-exit-4', reviewRounds: 0 })
    try {
      const second = await call(['review', task])
      // The retry owns the record: its own job id replaces the stale one.
      expect(second).toMatchObject({ status: 'running' })
      expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: second.job_id })
      const runDir = join(task, 'runs', '20261106-120200-codex-critic'); mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', role: 'critic', report_exists: true }))
      retry.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
      await vi.waitFor(() => expect(record()?.state).toBe('reviewed'))
      expect(record()).toMatchObject({ critic: { worker: 'codex', family: 'gpt' }, reviewRounds: 1 })
    } finally {
      // Let a still-running background job settle, so a failed assertion does not hang the teardown.
      retry.resolve('failed｜1.00 秒｜report.md 无｜')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  })

  it('spends a round on an attributed review failure and keeps the retry on its own job', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    const retry = Promise.withResolvers<string>()
    let reviews = 0
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) => {
      if (args[0] === 'critics') return '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok'
      reviews += 1
      if (reviews === 1) {
        // The critic ran in the producer's own family: the attempt is attributed, so it spends a round.
        const dir = join(task, 'runs', '20261106-120300-kimi-critic'); mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'kimi-k3-1-pro', family: 'moonshot', role: 'critic', report_exists: true }))
        return `failed｜1.00 秒｜report.md 有｜${dir}`
      }
      return retry.promise
    })
    const record = () => h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    await call(['review', task])
    await vi.waitFor(() => expect(record()?.state).toBe('reported'))
    expect(record()).toMatchObject({ errorClass: 'same-family', reviewRounds: 1, critic: { worker: '', family: '' } })
    try {
      const second = await call(['review', task])
      // The retry owns the record: its own job id replaces the stale one.
      expect(second).toMatchObject({ status: 'running' })
      expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: second.job_id, reviewRounds: 1 })
      const runDir = join(task, 'runs', '20261106-120400-codex-critic'); mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', role: 'critic', report_exists: true }))
      retry.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
      await vi.waitFor(() => expect(record()?.state).toBe('reviewed'))
      expect(record()).toMatchObject({ critic: { worker: 'codex', family: 'gpt' }, reviewRounds: 2 })
    } finally {
      // Let a still-running background job settle, so a failed assertion does not hang the teardown.
      retry.resolve('failed｜1.00 秒｜report.md 无｜')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  })

  it('does not let a superseded review callback advance a record owned by a newer job', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    const first = Promise.withResolvers<string>(), second = Promise.withResolvers<string>()
    let reviews = 0
    vi.mocked(Commands.prototype.run).mockImplementation(async (_bin, args) => {
      if (args[0] === 'critics') return '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok'
      reviews += 1
      return reviews === 1 ? first.promise : second.promise
    })
    const one = await call(['review', task])
    const current = h.runtime.store.tickets.get(ticket.id)!
    h.runtime.store.tickets.save({ ...current, delegations: [{ ...current.delegations![0]!, state: 'reported', reviewJobId: '' }] })
    const two = await call(['review', task])
    const record = () => h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: two.job_id })
    const runDir = join(task, 'runs', '20261106-120100-codex-critic'); mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', role: 'critic', report_exists: true }))
    first.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
    await vi.waitFor(() => expect(h.deliveries.mock.calls.some(([d]) => d.text.includes(String(one.job_id)))).toBe(true))
    // The stale callback still wakes the worker, but must not touch this record.
    expect(record()).toMatchObject({ state: 'reviewing', reviewJobId: two.job_id })
    second.resolve(`done｜1.00 秒｜report.md 有｜${runDir}`)
    await vi.waitFor(() => expect(record()?.state).toBe('reviewed'))
    expect(record()).toMatchObject({ critic: { worker: 'codex', family: 'gpt' }, reviewRounds: 1 })
  })
})

describe('verdict gate and exit-code fidelity', () => {
  const recorded = (patch: Partial<Delegation>): Delegation => ({
    id: 'test-card', chain: '@complex', taskDir: '/tmp/test-card', role: 'builder', jobId: 'fleet-0', state: 'reviewed',
    producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' }, critic: { worker: 'codex', family: 'gpt' }, reviewJobId: 'fleet-1',
    reviewConclusion: 'pass', verdict: '' as Delegation['verdict'], reviewRounds: 1, errorClass: '', startedAt: 'now', endedAt: 'now', ...patch,
  })
  const seed = (ticketId: string, patch: Partial<Delegation> = {}) => {
    const current = h.runtime.store.tickets.get(ticketId)!
    h.runtime.store.tickets.save({ ...current, delegations: [recorded(patch)] })
  }

  it('refuses a verdict while the delegation is still in flight and calls nothing', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { state: 'running', producer: { worker: '', family: '' }, critic: { worker: '', family: '' }, reviewRounds: 0 })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['verdict', task, 'pass'])).rejects.toThrow(/尚未完成|在飞|未结束/)
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'running', verdict: '' })
  })

  it('refuses a pass until a completed foreign-family review is recorded', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { state: 'reported', critic: { worker: '', family: '' } })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['verdict', task, 'pass'])).rejects.toThrow(/异族|评审/)
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reported', verdict: '' })

    seed(ticket.id, { state: 'reviewed', critic: { worker: 'kimi-k3-1-pro', family: 'moonshot' } })
    await expect(call(['verdict', task, 'pass'])).rejects.toThrow(/异族|评审/)
    expect(run).not.toHaveBeenCalled()
  })

  it('allows a pass review without an override and leaves overrideReason absent', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id)
    vi.mocked(Commands.prototype.run).mockResolvedValue('pass recorded')
    await call(['verdict', task, 'pass'])
    const record = h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)
    expect(record).toMatchObject({ state: 'verdicted', verdict: 'pass', reviewConclusion: 'pass' })
    expect(record).not.toHaveProperty('overrideReason')
  })

  it('rejects a rework review pass without an actual override option', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { reviewConclusion: 'rework' })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['verdict', task, 'pass'])).rejects.toThrow(/rework|返工/)
    // Another option's value is not an override, even when it spells the flag.
    await expect(call(['verdict', task, 'pass', '--note', '--override-reason'])).rejects.toThrow(/rework|返工/)
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reviewed', verdict: '' })
  })

  it('passes a rework review with an override and records its reason verbatim', async () => {
    const { call, task, ticket, directory } = await worker()
    seed(ticket.id, { reviewConclusion: 'rework' })
    const reason = '  Evidence accepts the documented residual risk.  '
    const run = vi.mocked(Commands.prototype.run); run.mockResolvedValue('pass recorded')
    await call(['verdict', task, 'pass', '--override-reason', reason])
    expect(run).toHaveBeenCalledWith('fleet', ['verdict', task, 'pass', '--override-reason', reason], directory)
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({
      state: 'verdicted', verdict: 'pass', reviewConclusion: 'rework', overrideReason: reason,
    })
  })

  it.each([{ conclusion: 'unknown' as const }, { conclusion: undefined }])('rejects a $conclusion review conclusion even with an override', async ({ conclusion }) => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { reviewConclusion: conclusion })
    const run = vi.mocked(Commands.prototype.run); run.mockClear()
    await expect(call(['verdict', task, 'pass', '--override-reason', 'evidence'])).rejects.toThrow(/unknown|结论行/)
    expect(run).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'reviewed', verdict: '' })
  })

  it('appends only recorded override reasons to the ready report summary and relay', async () => {
    const { ticket, sessionId } = await worker()
    const reason = '  Evidence accepts the documented residual risk.  '
    seed(ticket.id, { state: 'verdicted', verdict: 'pass', reviewConclusion: 'rework', overrideReason: reason })
    const current = h.runtime.store.tickets.get(ticket.id)!
    const plain = recorded({ id: 'plain-card', state: 'verdicted', verdict: 'pass' })
    h.runtime.store.tickets.save({ ...current, delegations: [current.delegations![0]!, plain] })
    const relay = vi.spyOn(h.runtime.sessions, 'relay')
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    const expected = `Done.\n\nFleet delegation overrideReason:\n- test-card: ${reason}`
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary).toBe(expected)
    expect(expected).not.toContain('plain-card')
    expect(relay).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(reason.trim()))
    expect(relay).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('test-card'))
    expect(relay).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining('plain-card'))
  })

  it('allows rework on a failed delegation once it is no longer in flight', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { state: 'failed', errorClass: 'fleet-exit-4' })
    vi.mocked(Commands.prototype.run).mockResolvedValue('rework recorded')
    await call(['verdict', task, 'rework'])
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'verdicted', verdict: 'rework' })
  })

  it('refuses every non-pass verdict on a delegation that already carries a verdict', async () => {
    const { call, task, ticket } = await worker()
    seed(ticket.id, { state: 'verdicted', verdict: 'pass' })
    const before = JSON.stringify(h.runtime.store.tickets.get(ticket.id)?.delegations)
    for (const verdict of ['rework', 'escalate', 'close']) {
      const run = vi.mocked(Commands.prototype.run); run.mockClear()
      await expect(call(['verdict', task, verdict])).rejects.toThrow(/该状态不能记录裁定/)
      expect(run).not.toHaveBeenCalled()
      expect(JSON.stringify(h.runtime.store.tickets.get(ticket.id)?.delegations)).toBe(before)
    }
  })

  it('keeps the fleet exit code from the original CliError before it is stringified', async () => {
    const { call, task, ticket } = await worker()
    vi.mocked(Commands.prototype.run).mockImplementation(async () => {
      throw new CliError('外部生产家族未知或与本卡运行记录冲突', undefined, 4)
    })
    await call(['run', '@complex', task])
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)?.errorClass).not.toBe(''), { timeout: 3000 })
    expect(h.runtime.store.tickets.get(ticket.id)?.delegations?.at(-1)).toMatchObject({ state: 'failed', errorClass: 'fleet-exit-4' })
  })
})
