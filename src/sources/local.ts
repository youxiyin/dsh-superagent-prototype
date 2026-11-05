/** Built-in Source for the person's messages in the orchestrator Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { Sessions } from '../app/sessions.ts'
import type { Store } from '../app/store.ts'
import { key, threadKey, type Trigger } from '../core/index.ts'
import { AllowedSchema, policyVersion } from '../policy.ts'
import { health, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'

const USER = { id: 'user', name: 'Local user' }
const CursorSchema = z.object({ at: z.string(), id: z.string() }).strict()
const PolicySchema = z.object({ allowed: z.array(AllowedSchema).default([])
  .transform(entries => [USER, ...entries.filter(entry => entry.id.toLowerCase() !== USER.id)]) }).strict()

/** The built-in adapter's Session delivery and registration dependencies. */
export interface LocalSourceHost extends SourceHost {
  readonly masterId: string
  readonly lifetime: AbortSignal
  readonly sessions: Pick<Sessions, 'prompt'>
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'read'>
}

/** Translate only person-authored messages; relays, notices and assistant output cannot trigger local work. */
export function localTrigger(agentId: string, event: SessionEvent): Trigger | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const message = event.data
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  return {
    id: key('local', agentId, message.id), source: 'local', threads: [{ source: 'local', id: agentId }],
    actor: { source: 'local', id: USER.id }, human: true, addressed: 'direct',
    at: new Date(event.time).toISOString(), text,
    channel: { source: 'local', thread: `local:${agentId}`, address: { agentId } },
    meta: { agentId, messageId: message.id },
  }
}

/** A local kind bound to this runtime's main Session and its existing idempotent relay delivery. */
export function localKind(host: LocalSourceHost): SourceKind {
  return {
    kind: 'local', title: { zh: '本地主 Session', en: 'Local main Session' },
    description: { zh: '接收主 Session 中本机用户的消息，并把答复送回原 Session。',
      en: 'Receives the local person’s messages in the main Session and returns replies there.' },
    schema: z.object({}).strict(), fields: [], health: ['local'],
    scope: ({ meta }) => meta.agentId === host.masterId
      ? { listened: true, observed: false } : { listened: false, reason: 'session_not_main' },
    channel: {
      allowed: address => address.agentId === host.masterId,
      async send(_context, message) {
        if (message.channel.address.agentId !== host.masterId) return 'gone'
        try {
          // prompt uses AgentDelivery, including its persisted history and pending-inbox deduplication.
          await host.sessions.prompt(message.channel.address.agentId, `local:${message.id}`, message.text, 'steer')
          return 'sent'
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'session/not-found') return 'gone'
          throw error
        }
      },
      link: () => ({ url: '', label: { zh: '本地主 Session', en: 'Local main Session' } }),
    },
    threadContext: {
      messageId: trigger => String(trigger.meta.messageId ?? ''),
      async read(_commands, trigger, part, cursor) {
        const before = cursor ? CursorSchema.parse(JSON.parse(cursor)) : undefined
        const thread = threadKey(trigger.threads[0]!)
        const root = part === 'root' ? host.store.read.firstTrigger(thread) : undefined
        const page = part === 'thread' ? host.store.read.threadTriggers(thread, 51, before) : root ? [root] : []
        const shown = page.slice(-50)
        const messages = shown.map(item => ({ id: String(item.meta.messageId), from: item.actor.id, at: item.at, text: item.text }))
        const first = shown[0]
        return { messages, body: { messages }, ...(page.length > 50 && first
          ? { next: JSON.stringify({ at: first.at, id: first.id }) } : {}) }
      },
    },
    policy: {
      schema: PolicySchema, fields: [],
      explicit: { zh: '本机用户在主 Session 中发送的消息都是显式请求；关闭此 Source 可停止接收。',
        en: 'The local person’s main-Session messages are explicit requests; turn this Source off to stop receiving them.' },
    },
    environment: {
      variables: [{ key: 'DSH_SUPERAGENT_LOCAL_AGENT_ID', description: {
        zh: '发起本地工单的主 Session；其他来源为空', en: 'The main Session that originated a local ticket; empty for other Sources' } }],
      values: ({ trigger }) => ({ DSH_SUPERAGENT_LOCAL_AGENT_ID: trigger?.source === 'local' ? String(trigger.meta.agentId ?? '') : '' }),
    },
  }
}

/** Register the built-in kind and its live event subscription; disposal and runtime stop both detach it. */
export function installLocalSource(ctx: Context, host: LocalSourceHost): () => void {
  const kind = localKind(host)
  const unregister = host.sources.register(kind)
  const source = host.context(kind)
  // The core gate reads saved Policy parts, so persist the local identity before accepting any event.
  const settings = host.store.settings()
  const previous = settings.policy.sources.local
  const part = { ...PolicySchema.parse(previous ? { allowed: previous.allowed } : {}), admission: previous?.admission ?? {} }
  if (JSON.stringify(previous) !== JSON.stringify(part)) {
    const next = { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, local: part } } }
    host.store.saveSettings(next, { source: 'internal', block: 'policy', policyVersion: policyVersion(next), policyChanged: true, notified: [] })
  }
  let active = true, ready = false
  const fail = (error: unknown) => { if (active) source.report('local', { state: 'error', detail: String(error) }) }
  const enabled = () => {
    if (!source.configured()) { source.report('local', health('paused', 'setupPending')); return false }
    if (!source.config('local')) { source.report('local', health('paused', 'sourceOff')); return false }
    return true
  }
  const off = ctx.on('session/event', (session, event) => {
    if (!active || !ready || session.id !== host.masterId || event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const receive = async () => {
      if (!enabled()) return
      const trigger = localTrigger(session.id, event)
      if (!trigger) return
      await source.receive(trigger)
      if (!active) return
      source.threads.describe(threadKey(trigger.threads[0]!), { label: 'Local main Session',
        facts: { agentId: { label: { zh: '主 Session', en: 'Main Session' }, value: session.id } } })
      source.report('local', { state: 'ready', detail: 'Listening to the main Session', at: trigger.at })
    }
    void receive().catch(fail)
  })
  void source.ready.then(() => {
    if (!active) return
    ready = true
    if (enabled()) source.report('local', { state: 'ready', detail: 'Listening to the main Session' })
  }).catch(fail)
  const dispose = () => {
    if (!active) return
    active = false
    off(); unregister()
    host.lifetime.removeEventListener('abort', dispose)
  }
  host.lifetime.addEventListener('abort', dispose, { once: true })
  if (host.lifetime.aborted) dispose()
  return dispose
}
