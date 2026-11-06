/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { fleetTools } from './fleet.ts'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify' | 'prompt'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    ...fleetTools(host.resources, host.sessions, ticket, work => host.store.atomic(work)),
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1).describe('Verbatim report body; limited by executor.fleet.reportMaxChars (default 20000). Shorten and resubmit if refused.'),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const maxChars = host.resources.store.settings().executor.fleet.reportMaxChars
        if (args.summary.length > maxChars) throw new Error(`Report has ${args.summary.length} characters; maximum is ${maxChars}. Shorten the summary and resubmit; no report was recorded.`)
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        const result = host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          // A ready report waits for every delegation's foreign-family review; no delegation keeps the old behavior.
          if (args.state === 'ready') {
            const delegations = host.store.tickets.get(ticketId)?.delegations ?? []
            const last = delegations.at(-1)
            if (last) {
              // 1. Any in-flight delegation blocks, not only the latest.
              if (delegations.some(item => item.state === 'running' || item.state === 'reviewing')) {
                throw new Error('The delegation is still in flight (委派尚未完成); wait for its result before reporting ready')
              }
              // 2. The latest delegation may not ask for rework.
              if (last.verdict === 'rework') throw new Error('The review requires rework (评审要求返工); address it before reporting ready')
              // 3. Any delegation that is neither verdicted nor failed must still pass, unless the round budget is spent.
              //    A superseded delegation (an earlier one already verdicted or failed) is closed and does not block.
              const rounds = host.resources.store.settings().executor.fleet.reviewRounds
              const pending = delegations.find(item => (item.state === 'reported' || item.state === 'reviewed') && !item.verdict)
              if (pending) {
                if (pending.reviewRounds >= rounds) throw new Error(`Review rounds exhausted (评审轮数已用尽): ${pending.reviewRounds}/${rounds}; escalate to a person`)
                throw new Error('The delegation has not passed a foreign-family review yet (委派尚未通过异族评审)')
              }
              // 4. The latest delegation must itself be verdicted pass; other terminal outcomes say so distinctly.
              if (last.state !== 'verdicted' || last.verdict !== 'pass') {
                if (last.state === 'failed') {
                  throw new Error('The final delegation failed and has no reviewed output (最后一次委派失败，没有通过评审的产出); delegate a new card before reporting ready')
                }
                throw new Error(`The delegation's verdict is ${last.verdict || '(none)'}; only pass allows ready (只有 pass 允许 ready)`)
              }
              // 5. Even a pass needs a critic from another family.
              if (!last.critic.family || last.critic.family === last.producer.family) {
                throw new Error('The reviewer is not from a foreign family (评审者必须来自异族); ready needs a different-family critic')
              }
            }
          }
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          const result = { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
          if (args.state === 'dropped' || args.state === 'progress' && !args.reply_to_trigger_id && !args.human_action) return result
          // Queue with the report transaction. A Channel refusal preserves the report and is returned explicitly;
          // neither the host nor the orchestrator may truncate or rewrite the body to make it fit.
          try {
            const reply = host.engine.reply({ purpose: 'report', ticketId, triggerId: args.reply_to_trigger_id })
            return { ...result, reply }
          } catch (error) { return { ...result, delivery_error: String(error) } }
        })
        if ('reply' in result && result.reply) {
          await host.sendReplies()
          return { ...result, reply: { id: result.reply.id, status: host.store.replyStatus(result.reply.id)! } }
        }
        return result
      },
    }),
  ]
}
