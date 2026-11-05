/** Ordinary-conversation answers from the main Session, local and through Feishu. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AssistantAnswer } from '../src/app/sessions.ts'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { localTrigger } from '../src/sources/local.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    local: { allowed: [{ id: 'user', name: 'Local user' }], admission: {} } } } })
})
afterEach(async () => { await h.stop() })

const answer = (text: string, timedOut = false): AssistantAnswer => ({ sessionId: 'assistant-x', text, timedOut })
const chat = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_chat', args)
const local = (text: string): Trigger => localTrigger(h.runtime.masterId, { type: 'user/message', seq: SessionSeq(0),
  time: Date.parse('2026-11-03T00:00:00Z'), surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })!
const outboxRows = () => h.runtime.store.db.prepare('SELECT id FROM outbox ORDER BY rowid').all()
const feishuTexts = (): string[] => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  .filter(args => args[1] === '+messages-reply').map(args => String(args[args.indexOf('--markdown') + 1]))
/** Record the master Session's message log, so the tool reads the request as it does from DSH's events. */
const masterMessages = (...messages: { source: string; text: string }[]) => {
  h.agents.get(h.runtime.masterId)!.session.snapshotEvents = () => messages.map((message, seq) => ({ seq, type: 'user/message',
    data: { id: `message-${seq}`, source: { kind: message.source }, content: [{ type: 'text', text: message.text }] } }))
}

it('answers the latest local message in the general assistant and returns the answer for the main Session to relay', async () => {
  masterMessages({ source: 'user', text: '你好' }, { source: 'tool-jobs', text: 'Job bash-1 ended: completed' })
  const run = vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('你好，我可以帮你整理文件。'))
  expect(await chat({})).toEqual({ answer: '你好，我可以帮你整理文件。', session_id: 'assistant-x' })
  expect(run).toHaveBeenCalledWith(`local:${h.runtime.masterId}`, '你好', expect.any(AbortSignal))
  expect(feishuTexts()).toEqual([])
})

it('refuses a local call when the latest request is not a local person message', async () => {
  masterMessages({ source: 'dsh-superagent', text: 'Candidate card for trigger t1' })
  await expect(chat({})).rejects.toThrow('There is no local message')
})

it('answers an addressed Feishu message in its chat and settles its candidate as conversation', async () => {
  const trigger = feishu('1', '你好')
  h.runtime.receive(trigger); await h.runtime.idle()
  const before = outboxRows()
  vi.mocked(Commands.prototype.lark).mockClear()
  const run = vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('你好！有什么可以帮你的？'))
  expect(await chat({ trigger_id: trigger.id })).toMatchObject({ decision: 'ignore', reason: 'Answered as ordinary conversation',
    answered: true, session_id: 'assistant-x', replies: [{ status: 'sent' }] })
  expect(outboxRows()).toHaveLength(before.length + 1)
  expect(run).toHaveBeenCalledWith('feishu:oc_team', '你好', expect.any(AbortSignal))
  const disposition = h.runtime.store.triggers.disposition(trigger.id)!
  expect(h.runtime.store.decisions.get(disposition.decisionId!)).toMatchObject({ kind: 'ignore', reason: [{ code: 'chat' }],
    triggerIds: [trigger.id] })
  expect(feishuTexts()).toEqual(['你好！有什么可以帮你的？'])
  const reply = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args).find(args => args[1] === '+messages-reply')!
  expect(reply).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--reply-in-thread']))
})

it('splits a long answer into several chat messages', async () => {
  const trigger = feishu('2', '写一段很长的说明')
  h.runtime.receive(trigger); await h.runtime.idle()
  vi.mocked(Commands.prototype.lark).mockClear()
  vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('a'.repeat(4000)))
  await chat({ trigger_id: trigger.id })
  expect(feishuTexts()).toEqual(['a'.repeat(3000), 'a'.repeat(1000)])
})

it('posts a partial answer with a notice when the assistant times out', async () => {
  const trigger = feishu('3', '写一篇长文')
  h.runtime.receive(trigger); await h.runtime.idle()
  vi.mocked(Commands.prototype.lark).mockClear()
  vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('第一部分', true))
  expect(await chat({ trigger_id: trigger.id })).toMatchObject({ timed_out: true, answered: true })
  expect(feishuTexts()).toEqual(['第一部分', '（答复超时，以上是尚未完成的部分。）'])
})

it('refuses an unaddressed message, a message a ticket owns, and one already decided', async () => {
  const passive = feishu('4', '中午吃什么', { mentions: [] })
  h.runtime.receive(passive); await h.runtime.idle()
  await expect(chat({ trigger_id: passive.id })).rejects.toThrow('Only a Feishu direct message')
  await h.acceptedTicket(feishu('5', '@bot 修一下回归'))
  const followed = feishu('6', '@bot 顺便看看日志', { root_id: 'om_5' })
  h.runtime.receive(followed); await h.runtime.idle()
  await expect(chat({ trigger_id: followed.id })).rejects.toThrow('its worker decides it')
  const decided = feishu('7', '@bot 谢谢')
  h.runtime.receive(decided); await h.runtime.idle()
  h.runtime.engine.decide(decided.id, { kind: 'ignore', reason: 'Thanks only.' })
  await expect(chat({ trigger_id: decided.id })).rejects.toThrow('Decision of kind ignore')
})

it('answers a requeued message whose earlier decision no longer settles it', async () => {
  const decided = feishu('8', '@bot 你好')
  h.runtime.receive(decided); await h.runtime.idle()
  h.runtime.engine.decide(decided.id, { kind: 'ignore', reason: 'Greeting only.' })
  expect(h.runtime.engine.reevaluate(decided.id)).toBe(true)
  vi.mocked(Commands.prototype.lark).mockClear()
  vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('你好！'))
  expect(await chat({ trigger_id: decided.id })).toMatchObject({ decision: 'ignore', answered: true, replies: [{ status: 'sent' }] })
  const disposition = h.runtime.store.triggers.disposition(decided.id)!
  expect(h.runtime.store.decisions.get(disposition.decisionId!)).toMatchObject({ kind: 'ignore', reason: [{ code: 'chat' }] })
  expect(feishuTexts()).toEqual(['你好！'])
})

it('answers a local trigger and returns the answer without writing the outbox', async () => {
  const trigger = local('你好')
  h.runtime.receive(trigger); await h.runtime.idle()
  const before = outboxRows()
  const run = vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer('你好！'))
  expect(await chat({ trigger_id: trigger.id })).toMatchObject({ answer: '你好！', session_id: 'assistant-x',
    decision: 'ignore', reason: 'Answered as ordinary conversation', decided: [trigger.id] })
  expect(run).toHaveBeenCalledWith(`local:${h.runtime.masterId}`, '你好', expect.any(AbortSignal))
  const disposition = h.runtime.store.triggers.disposition(trigger.id)!
  expect(h.runtime.store.decisions.get(disposition.decisionId!)).toMatchObject({ kind: 'ignore', reason: [{ code: 'chat' }],
    triggerIds: [trigger.id] })
  expect(outboxRows()).toEqual(before)
  expect(feishuTexts()).toEqual([])
})

it.each([
  { label: 'not human', patch: { human: false } },
  { label: 'unaddressed', patch: { addressed: undefined } },
  { label: 'explicitly not addressed', patch: { addressed: false } },
])('refuses a local trigger that is $label', async ({ patch }) => {
  const trigger = { ...local('你好'), ...patch } as Trigger
  h.runtime.receive(trigger); await h.runtime.idle()
  await expect(chat({ trigger_id: trigger.id })).rejects.toMatchObject({ code: 'chatNeedsAddressed' })
})

it('refuses other sources and a Feishu trigger without a channel', async () => {
  const github = { ...feishu('9', '你好'), source: 'github' }
  const channelless = { ...feishu('10', '你好'), channel: undefined }
  h.runtime.receive(github); h.runtime.receive(channelless); await h.runtime.idle()
  await expect(chat({ trigger_id: github.id })).rejects.toMatchObject({ code: 'chatNeedsConversation' })
  await expect(chat({ trigger_id: channelless.id })).rejects.toMatchObject({ code: 'chatNeedsConversation' })
})

it('reports a local assistant failure without a Feishu notice', async () => {
  const trigger = local('你好')
  h.runtime.receive(trigger); await h.runtime.idle()
  vi.spyOn(h.runtime.sessions, 'runAssistant').mockRejectedValue(new Error('offline'))
  await expect(chat({ trigger_id: trigger.id })).rejects.toMatchObject({ code: 'chatUnavailable' })
  expect(feishuTexts()).toEqual([])
})

it('reports an empty answer to a local trigger', async () => {
  const trigger = local('你好')
  h.runtime.receive(trigger); await h.runtime.idle()
  vi.spyOn(h.runtime.sessions, 'runAssistant').mockResolvedValue(answer(''))
  await expect(chat({ trigger_id: trigger.id })).rejects.toMatchObject({ code: 'chatEmpty' })
})
