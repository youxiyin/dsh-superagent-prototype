/** Reports reach actual local Session delivery and Feishu CLI transport without a model rewriting the body. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { installLocalSource, localTrigger } from '../src/sources/local.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
let dispose: (() => void) | undefined
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { dispose?.(); dispose = undefined; await h.stop() })
const body = '  完成。\r\n\n**原文**\n```ts\nconst x = "<>&"\n```\n👩🏽‍💻 e\u0301\t \n'

it('sends the complete worker report as kind reply into the originating main Session', async () => {
  dispose = installLocalSource(h.ctx, h.runtime)
  await vi.waitFor(() => expect(h.runtime.health.local?.state).toBe('ready'))
  const trigger = localTrigger(h.runtime.masterId, { type: 'user/message', seq: SessionSeq(0), time: Date.now(), surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: '完成本地工作' }], source: { kind: 'user' } }) })!
  const { sessionId, ticket } = await h.acceptedTicket(trigger)
  const send = vi.spyOn(h.runtime.outbox, 'send')
  h.deliveries.mockClear()
  const text = body + '长正文'.repeat(1000)
  const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: text })
  expect(result).toMatchObject({ reported: true, reply: { status: 'sent' } })
  expect(send.mock.calls.map(([message]) => message).filter(message => message.kind === 'reply')).toEqual([
    expect.objectContaining({ kind: 'reply', text, ticketId: ticket.id, channel: trigger.channel }),
  ])
  const delivered = h.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === h.runtime.masterId && d.text === text)
  expect(delivered).toHaveLength(1)
  expect(Buffer.from(delivered[0]!.text)).toEqual(Buffer.from(text))
  const message = h.agents.get(h.runtime.masterId)!.steer.mock.calls.find(([message]) => message.content.some(part => part.type === 'text' && part.text === text))![0]
  expect(message.source.kind).toBe('dsh-superagent')
})

it('sends a report of over 300 words verbatim to the originating Feishu thread as kind reply', async () => {
  const { sessionId, trigger, ticket } = await h.acceptedTicket(feishu('1', '完成飞书工作'))
  const send = vi.spyOn(h.runtime.outbox, 'send'), lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
  const text = 'evidence '.repeat(300) + body
  const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: text })
  expect(result).toMatchObject({ reply: { status: 'sent' } })
  const message = send.mock.calls.map(([message]) => message).find(message => message.kind === 'reply')!
  expect(message).toMatchObject({ kind: 'reply', text, workerReport: true, ticketId: ticket.id, channel: trigger.channel })
  const sends = lark.mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  expect(sends).toHaveLength(1)
  expect(sends[0]).toEqual(['im', '+messages-reply', '--message-id', trigger.channel!.address.messageId,
    '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id])
  expect(Buffer.from(sends[0]![sends[0]!.indexOf('--markdown') + 1]!)).toEqual(Buffer.from(text))
  h.runtime.engine.reply({ purpose: 'report', ticketId: ticket.id })
  await h.runtime.sendReplies()
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(1)
})

it('keeps ordinary progress internal and preserves attention with the original report body', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('1', '需要确认的工作'))
  const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '正在处理' })).toMatchObject({ notification: 'internal_only' })
  expect(lark).not.toHaveBeenCalled()
  const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: body, human_action: '允许删除吗？' })
  expect(result).toMatchObject({ attention: { question: '允许删除吗？' }, reply: { status: 'sent' } })
  const args = lark.mock.calls.find(([argv]) => argv.includes('--markdown'))![0]
  expect(args[args.indexOf('--markdown') + 1]).toBe(`${body}\n\n允许删除吗？`)
})

it('still refuses main replies over 100 words, including replies carrying a ticketId', async () => {
  const { sessionId, ticket, trigger } = await h.acceptedTicket(feishu('1', '长报告'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
  const text = 'evidence '.repeat(101)
  expect(() => h.runtime.engine.reply({ purpose: 'result', ticketId: ticket.id, text })).toThrow('maximum is 100')
  expect(() => h.runtime.outbox.send({ id: 'ordinary-reply', channel: ticket.channels[0]!, kind: 'reply', text })).toThrow('maximum is 100')
  await expect(h.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text })).rejects.toThrow('at most 100 words')
  expect(h.runtime.outbox.status('ordinary-reply')).toBeUndefined()
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toEqual([])
})

it.each([1000, 20000])('refuses reports over %i characters before changing the ticket or report, then accepts a shortened submission', async maxChars => {
  const { sessionId, ticket } = await h.acceptedTicket(feishu('1', '长报告'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Prior report' })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, fleet: { ...settings.executor.fleet, reportMaxChars: maxChars } } })
  const before = h.runtime.store.tickets.get(ticket.id)!
  const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
  const report = vi.spyOn(h.runtime.engine, 'report'), reply = vi.spyOn(h.runtime.outbox, 'send'), relay = vi.spyOn(h.runtime.sessions, 'relay')
  const text = 'x'.repeat(maxChars + 1)
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: text, human_action: null, pr_number: 123 }))
    .rejects.toThrow(`maximum is ${maxChars}`)
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
  expect(report).not.toHaveBeenCalled()
  expect(reply).not.toHaveBeenCalled()
  expect(relay).not.toHaveBeenCalled()
  expect(lark).not.toHaveBeenCalled()
  const shortened = text.slice(1)
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: shortened })).toMatchObject({ reported: true, reply: { status: 'sent' } })
  expect(lark.mock.calls.find(([args]) => args.includes('--markdown'))![0]).toContain(shortened)
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary).toBe(shortened)
})
