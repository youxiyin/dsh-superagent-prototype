/** Local Source on the real Runtime, Store, Engine, Outbox and Session delivery with a simulated DSH host. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { allowedSender } from '../src/policy.ts'
import { installLocalSource, localKind, localTrigger } from '../src/sources/local.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
let dispose: () => void
beforeEach(async () => {
  h = await startRuntime()
  dispose = installLocalSource(h.ctx, h.runtime)
  await vi.waitFor(() => { expect(h.runtime.health.local?.state).toBe('ready') })
})
afterEach(async () => { dispose(); await h.stop() })

const eventOf = (message: UserMessage, seq = 0): Extract<SessionEvent, { type: 'user/message' }> => ({ type: 'user/message', seq: SessionSeq(seq),
  time: Date.parse('2026-11-02T00:00:00Z') + seq * 1000, surfaceOp: 'append', data: message })
const userEvent = (text: string, seq = 0) => eventOf(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), seq)
const emit = (event: SessionEvent, sessionId = h.runtime.masterId) => {
  const session = h.agents.get(sessionId)!.session
  h.ctx.emit('session/event', session as never, event)
}
const triggers = () => h.runtime.store.read.triggers({ source: 'local' }).items
const outbound = (id: string, text: string, kind: OutboundMessage['kind'] = 'reply'): OutboundMessage => ({
  id, kind, text, channel: { source: 'local', thread: `local:${h.runtime.masterId}`, address: { agentId: h.runtime.masterId } },
})
const sentText = () => h.deliveries.mock.calls.map(([item]) => item.text)

it('stores a main-Session message once as an explicit candidate and routes it to a ticket', async () => {
  const event = userEvent('请修复保存按钮。')
  emit(event); emit(event)
  await h.runtime.idle()
  const trigger = triggers()[0]!
  expect(triggers()).toHaveLength(1)
  expect(trigger).toMatchObject({ id: key('local', h.runtime.masterId, event.data.id),
    source: 'local', human: true, addressed: 'direct', actor: { source: 'local', id: 'user' }, text: '请修复保存按钮。',
    at: '2026-11-02T00:00:00.000Z', channel: { address: { agentId: h.runtime.masterId } } })
  expect(allowedSender(h.runtime.store.settings(), trigger.actor)).toMatchObject({ id: 'user' })
  expect(h.runtime.engine.candidate(trigger.id)?.strength).toBe('explicit')
  expect(h.candidates()).toEqual([trigger.id])
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: '修复保存按钮',
    worktree_name: 'fix-save', acknowledgement: '收到，修复保存按钮。' })
  expect(result.decision).toBe('accept')
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.tickets.list()[0]!.mandate).toMatchObject({ strength: 'explicit', actor: trigger.actor })
  expect(sentText()).toContain('收到，修复保存按钮。')
  expect(triggers()).toHaveLength(1)
})

it('uses one Thread and channel per main Session, with distinct stable message ids', async () => {
  const first = userEvent('第一件事', 1), second = userEvent('第二件事', 2)
  emit(first); emit(second)
  await h.runtime.idle()
  expect(triggers()).toHaveLength(2)
  expect(new Set(triggers().map(trigger => trigger.id)).size).toBe(2)
  expect(triggers().map(trigger => trigger.threads)).toEqual([
    [{ source: 'local', id: h.runtime.masterId }], [{ source: 'local', id: h.runtime.masterId }],
  ])
  expect(h.runtime.store.threads.list()).toHaveLength(1)
  expect(triggers()[0]!.channel).toEqual(triggers()[1]!.channel)
  expect(localTrigger('another-master', first)?.threads).toEqual([{ source: 'local', id: 'another-master' }])
  expect(localTrigger('another-master', first)?.id).not.toBe(localTrigger(h.runtime.masterId, first)?.id)
})

it('ignores worker, assistant, relay, notice and other plugin messages', async () => {
  await h.controller.create({ sessionId: 'other-session' })
  emit(userEvent('worker input'), 'other-session')
  const event = userEvent('not a local user')
  for (const kind of ['dsh-superagent', 'tool-jobs', 'plugin']) {
    emit({ ...event, data: { ...(event as Extract<SessionEvent, { type: 'user/message' }>).data,
      source: { kind, form: 'relay' } } } as SessionEvent)
  }
  emit({ type: 'turn/start', seq: SessionSeq(5), time: Date.now(), data: { turn: 1 } })
  await h.runtime.idle()
  expect(triggers()).toEqual([])
  // Outbound replies are delivered under the plugin's identity and also cannot become local Triggers.
  h.runtime.outbox.send(outbound('no-loop', '这是回复。'))
  await h.runtime.sendReplies()
  expect(triggers()).toEqual([])
  expect(h.agents.get(h.runtime.masterId)!.steer.mock.calls.at(-1)![0].source.kind).toBe('dsh-superagent')
})

it('deduplicates sends by message id in the inbox, in consumed history and after adapter reinstallation', async () => {
  const message = outbound('same-id', '只投递一次。')
  const send = () => h.runtime.sources.send(message, h.runtime.commands)
  expect(await Promise.all([send(), send()])).toEqual(['sent', 'sent'])
  expect(sentText()).toEqual([message.text])
  const agent = h.agents.get(h.runtime.masterId)!
  const delivered = agent.steer.mock.calls.at(-1)![0]
  emit(eventOf(delivered))
  agent.inbox.nextStep.length = 0
  expect(await send()).toBe('sent')
  dispose()
  dispose = installLocalSource(h.ctx, h.runtime)
  expect(await send()).toBe('sent')
  expect(sentText()).toEqual([message.text])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('deduplicates an already persisted reply when Session delivery is recreated', async () => {
  const message = outbound('persisted', '重启前已发送。')
  await h.runtime.sources.send(message, h.runtime.commands)
  const delivered = h.agents.get(h.runtime.masterId)!.steer.mock.calls.at(-1)![0]
  const { AgentDelivery } = await import('../src/app/delivery.ts')
  const agent = h.agents.get(h.runtime.masterId)!
  agent.inbox.nextStep.length = 0
  vi.mocked(h.ctx.sessionPersistence.open).mockResolvedValue({ read: async (offset: number) => ({ events: offset ? [] : [eventOf(delivered)] }),
    [Symbol.asyncDispose]: async () => {} } as never)
  const restored = new AgentDelivery(h.ctx)
  const prompt = async (_sessionId: string, requestId: string, text: string) => {
    await restored.send(agent as never, key(requestId), text, 'steer', h.runtime.lifetime)
  }
  const kind = localKind({ masterId: h.runtime.masterId, lifetime: h.runtime.lifetime, sources: h.runtime.sources,
    store: h.runtime.store, context: kind => h.runtime.context(kind), sessions: { prompt } })
  expect(await kind.channel!.send({ commands: h.runtime.commands }, message)).toBe('sent')
  expect(sentText()).toEqual([message.text])
})

it('delivers reply text verbatim, preserving whitespace, Unicode, markdown and long content', async () => {
  const text = '  第一行\r\n\n**保留 Markdown**\n```ts\nconst x = "<>&"\n```\n👩🏽‍💻 e\u0301\n' + '原文'.repeat(2000) + '\t \n'
  const message = outbound('verbatim', text)
  h.runtime.outbox.send(message)
  await h.runtime.sendReplies()
  h.runtime.outbox.send({ ...message, text: '重复 ID 不得覆盖原文。' })
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(message.id)).toBe('sent')
  expect(sentText()).toEqual([text])
  expect(Buffer.from(sentText()[0]!)).toEqual(Buffer.from(text))
})

it('defaults to enabled and stops intake through the existing Source settings switch', async () => {
  expect(h.runtime.sources.instance('local')).toMatchObject({ enabled: true, config: {} })
  const toggle = async (enabled: boolean) => h.runtime.settings.save('source:local', { enabled, config: {} },
    h.runtime.store.blockRevision('source:local'), 'panel')
  expect(await toggle(false)).toMatchObject({ saved: true, restarting: false })
  const off = userEvent('关闭时不应开工单。')
  emit(off)
  await h.runtime.idle()
  expect(triggers()).toEqual([])
  expect(h.runtime.health.local).toMatchObject({ state: 'paused', code: 'sourceOff' })
  expect(await toggle(true)).toMatchObject({ saved: true, restarting: false })
  emit(userEvent('重新开启后接收。', 1))
  await h.runtime.idle()
  expect(triggers().map(trigger => trigger.text)).toEqual(['重新开启后接收。'])
})

it('preserves a stored disabled switch when the adapter is installed again', async () => {
  await h.runtime.settings.save('source:local', { enabled: false, config: {} }, 0, 'panel')
  dispose()
  const settings = h.runtime.store.settings()
  dispose = installLocalSource(h.ctx, h.runtime)
  await Promise.resolve()
  emit(userEvent('仍应关闭。'))
  await h.runtime.idle()
  expect(h.runtime.sources.instance('local')?.enabled).toBe(false)
  expect(h.runtime.store.settings()).toEqual(settings)
  expect(triggers()).toEqual([])
})

it('keeps outbound messages pending while the Source is off and sends after re-enabling', async () => {
  await h.runtime.settings.save('source:local', { enabled: false, config: {} }, 0, 'panel')
  h.runtime.outbox.send(outbound('wait-for-source', '等开启后投递。'))
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('wait-for-source')).toBe('pending')
  expect(sentText()).toEqual([])
  await h.runtime.settings.save('source:local', { enabled: true, config: {} }, h.runtime.store.blockRevision('source:local'), 'panel')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5001 })
  try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  expect(h.runtime.outbox.status('wait-for-source')).toBe('sent')
  expect(sentText()).toEqual(['等开启后投递。'])
})

it('waits for startup and configuration and detaches its listener on disposal', async () => {
  dispose()
  const ready = Promise.withResolvers<void>()
  const context = h.runtime.context.bind(h.runtime)
  let configured = false
  vi.spyOn(h.runtime, 'context').mockImplementation(kind => ({ ...context(kind), ready: ready.promise, configured: () => configured }))
  dispose = installLocalSource(h.ctx, h.runtime)
  emit(userEvent('startup pending'))
  ready.resolve()
  await Promise.resolve()
  expect(h.runtime.health.local).toMatchObject({ state: 'paused', code: 'setupPending' })
  emit(userEvent('setup pending'))
  expect(triggers()).toEqual([])
  configured = true
  emit(userEvent('ready'))
  await h.runtime.idle()
  expect(triggers()).toHaveLength(1)
  dispose()
  emit(userEvent('disposed'))
  expect(triggers()).toHaveLength(1)
  expect(h.runtime.sources.kind('local')).toBeUndefined()
  expect(h.runtime.health.local).toBeUndefined()
})

it('reports receive failures without an unhandled rejection and recovers on the next event', async () => {
  dispose()
  const context = h.runtime.context.bind(h.runtime)
  const receive = vi.fn().mockRejectedValueOnce(new Error('intake failed')).mockImplementation(trigger => h.runtime.receive(trigger))
  vi.spyOn(h.runtime, 'context').mockImplementation(kind => ({ ...context(kind), receive }))
  dispose = installLocalSource(h.ctx, h.runtime)
  await Promise.resolve()
  const event = userEvent('retry intake')
  emit(event)
  await vi.waitFor(() => { expect(h.runtime.health.local).toMatchObject({ state: 'error', detail: 'Error: intake failed' }) })
  emit(event)
  await h.runtime.idle()
  expect(triggers()).toHaveLength(1)
  expect(h.runtime.health.local?.state).toBe('ready')
})

it('returns gone only for a missing or non-main Session and propagates transient send failures', async () => {
  const message = outbound('send-error', 'reply')
  const prompt = vi.spyOn(h.runtime.sessions, 'prompt')
  prompt.mockRejectedValueOnce(new Error('persistence busy'))
  await expect(h.runtime.sources.send(message, h.runtime.commands)).rejects.toThrow('persistence busy')
  prompt.mockRejectedValueOnce({ code: 'session/not-found' })
  expect(await h.runtime.sources.send(message, h.runtime.commands)).toBe('gone')
  expect(await h.runtime.sources.send({ ...message, channel: { ...message.channel, address: { agentId: 'worker-x' } } }, h.runtime.commands)).toBe('gone')
  expect(prompt).toHaveBeenCalledTimes(2)
})

it('reads bounded Thread context without repeats and exposes the local execution variable', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true })
  for (let seq = 0; seq < 53; seq++) emit(userEvent(`message-${seq}`, seq))
  await h.runtime.idle()
  const trigger = triggers()[0]!
  const context = h.runtime.sources.threadContext(trigger)!
  const first = await context.read(h.runtime.commands, 'thread')
  expect(first.messages.map(message => message.text)).toEqual(Array.from({ length: 50 }, (_, i) => `message-${i + 3}`))
  const second = await context.read(h.runtime.commands, 'thread', first.next)
  expect(second.messages.map(message => message.text)).toEqual(['message-0', 'message-1', 'message-2'])
  expect(second.next).toBeUndefined()
  expect((await context.read(h.runtime.commands, 'root')).messages[0]!.text).toBe('message-0')
  expect((await context.read(h.runtime.commands, 'parent')).messages).toEqual([])
  const kind = h.runtime.sources.kind('local')!
  expect(kind.environment!.values({ deployment: h.runtime.deployment, config: {}, trigger }))
    .toEqual({ DSH_SUPERAGENT_LOCAL_AGENT_ID: h.runtime.masterId })
  expect(kind.environment!.values({ deployment: h.runtime.deployment, config: {} })).toEqual({ DSH_SUPERAGENT_LOCAL_AGENT_ID: '' })
})
