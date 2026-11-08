import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import type { FleetStatsReader, FleetStatsView } from '../src/app/views/settings.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1', readStats?: FleetStatsReader) {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost, readStats)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

function settingsRuntime(bin = '/opt/fleet') {
  const settings = SettingsSchema.parse({ executor: { fleet: { bin } } })
  return {
    store: { settings: () => settings, blockRevision: () => 0, get: () => undefined },
    sources: { instances: () => [], environments: () => [], declarations: () => [] },
    health: {}, machine: { stateDir: '/state' }, configured: () => false,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

it('returns Settings before a pending fleet stats read and degrades its failure to unknown', async () => {
  const reading = deferred<FleetStatsView>()
  let settled = false
  void reading.promise.then(() => { settled = true }, () => { settled = true })
  const read = vi.fn(() => reading.promise)
  const call = serve(settingsRuntime(), undefined, read)
  const response = await call('GET', 'settings')
  expect(response).toMatchObject({ status: 200, body: { stats: { summary: null } } })
  expect(settled).toBe(false)
  expect(read).toHaveBeenCalledOnce()
  reading.reject(new Error('fleet missing'))
  await reading.promise.catch(() => {})
  expect(await call('GET', 'settings')).toMatchObject({ status: 200, body: { stats: { summary: null } } })
  expect(read).toHaveBeenCalledOnce()
})

it('shares one pending fleet stats read across concurrent Settings requests', async () => {
  const reading = deferred<FleetStatsView>()
  let settled = false
  void reading.promise.then(() => { settled = true })
  const read = vi.fn(() => reading.promise)
  const call = serve(settingsRuntime(), undefined, read)
  const responses = await Promise.all([call('GET', 'settings'), call('GET', 'settings')])
  expect(responses.map(response => response.status)).toEqual([200, 200])
  expect(responses.map(response => response.body.stats)).toEqual([{ summary: null }, { summary: null }])
  expect(settled).toBe(false)
  expect(read).toHaveBeenCalledOnce()
  reading.resolve({ summary: 'Runs: 4\nCost: $2.50' })
  await reading.promise
  expect(await call('GET', 'settings')).toMatchObject({ status: 200, body: { stats: { summary: 'Runs: 4\nCost: $2.50' } } })
  expect(read).toHaveBeenCalledOnce()
})

it('refreshes expired fleet stats in the background while fresh values stay cached', async () => {
  vi.useFakeTimers()
  try {
    const first = deferred<FleetStatsView>(), second = deferred<FleetStatsView>()
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const call = serve(settingsRuntime(), undefined, read)
    expect(await call('GET', 'settings')).toMatchObject({ body: { stats: { summary: null } } })
    first.resolve({ summary: 'old' })
    await first.promise
    expect(await call('GET', 'settings')).toMatchObject({ body: { stats: { summary: 'old' } } })
    expect(read).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(30_000)
    expect(await call('GET', 'settings')).toMatchObject({ status: 200, body: { stats: { summary: null } } })
    expect(read).toHaveBeenCalledTimes(2)
    second.resolve({ summary: 'new' })
    await second.promise
    expect(await call('GET', 'settings')).toMatchObject({ body: { stats: { summary: 'new' } } })
    expect(read).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it('keeps fleet stats caches isolated between HTTP server instances', async () => {
  const first = deferred<FleetStatsView>(), second = deferred<FleetStatsView>()
  const readFirst = vi.fn(() => first.promise), readSecond = vi.fn(() => second.promise)
  const callFirst = serve(settingsRuntime(), undefined, readFirst)
  const callSecond = serve(settingsRuntime(), undefined, readSecond)
  await callFirst('GET', 'settings')
  first.resolve({ summary: 'first' })
  await first.promise
  expect(await callFirst('GET', 'settings')).toMatchObject({ body: { stats: { summary: 'first' } } })
  expect(await callSecond('GET', 'settings')).toMatchObject({ body: { stats: { summary: null } } })
  expect(readSecond).toHaveBeenCalledOnce()
  second.resolve({ summary: 'second' })
  await second.promise
  expect(await callSecond('GET', 'settings')).toMatchObject({ body: { stats: { summary: 'second' } } })
  expect(await callFirst('GET', 'settings')).toMatchObject({ body: { stats: { summary: 'first' } } })
})
