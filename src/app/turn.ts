/** Readers for the turn boundaries of a general-assistant Session's event log. */

/** The parts of a Session event these readers use; the log's own payloads are read loosely. */
export interface TurnEvent { readonly seq: number; readonly type: string; readonly data: unknown }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined

/** The seq of the `user/message` event whose message id is `messageId`, at or after `fromSeq`. */
export function findUserMessage(events: readonly TurnEvent[], messageId: string, fromSeq = 0): number | undefined {
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'user/message') continue
    if (record(event.data)?.id === messageId) return event.seq
  }
  return undefined
}

/**
 * The turn number that owns the message at `anchorSeq`: the nearest `turn/start` or `step/start` before it, or the first
 * boundary after it when a turn opens on the message.
 */
export function turnOfMessage(events: readonly TurnEvent[], anchorSeq: number): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.seq >= anchorSeq) continue
    if (event.type !== 'turn/start' && event.type !== 'step/start') continue
    const turn = number(record(event.data)?.turn)
    if (turn !== undefined) return turn
  }
  for (const event of events) {
    if (event.seq <= anchorSeq || (event.type !== 'turn/start' && event.type !== 'step/start')) continue
    const turn = number(record(event.data)?.turn)
    if (turn !== undefined) return turn
  }
  return undefined
}

/**
 * The text of the latest local person message, skipping runtime notices and reminders, or undefined when the latest
 * request-bearing event is not local (such as a Feishu candidate).
 */
export function latestLocalRequest(events: readonly TurnEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type !== 'user/message') continue
    const data = record(event.data)
    const kind = record(data?.source)?.kind
    if (kind === 'dsh-superagent') return undefined
    if (kind !== 'user') continue
    const content = Array.isArray(data?.content) ? data.content : []
    const text = content.flatMap(block => {
      const part = record(block)
      return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    }).join('')
    return text.trim() === '' ? undefined : text
  }
  return undefined
}

/** The turn that started and has not ended yet, or undefined between turns. */
export function activeTurn(events: readonly TurnEvent[]): number | undefined {
  let active: number | undefined
  for (const event of events) {
    const turn = number(record(event.data)?.turn)
    if (event.type === 'turn/start') active = turn
    else if (event.type === 'turn/end' && turn === active) active = undefined
  }
  return active
}

/**
 * The text and end of `turn` after `anchorSeq`: the latest settled assistant message plus text streamed by the step still
 * running. `ended` is true once that turn's `turn/end` is in the log.
 */
export function collectAssistantTurn(events: readonly TurnEvent[], anchorSeq: number, turn: number):
  { text: string; ended: boolean; reason: unknown } {
  let finalText = ''
  let chunkKey: string | undefined
  let chunkText = ''
  let ended = false
  let reason: unknown
  for (const event of events) {
    if (event.seq <= anchorSeq) continue
    const data = record(event.data)
    if (event.type === 'turn/end' && number(data?.turn) === turn) { ended = true; reason = data?.reason; break }
    if (number(data?.turn) !== turn) continue
    if (event.type === 'assistant/message') {
      const message = record(data?.message)
      const content = Array.isArray(message?.content) ? message.content : []
      const joined = content.flatMap(block => {
        const part = record(block)
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      }).join('')
      if (joined !== '') finalText = joined
      chunkKey = undefined
      chunkText = ''
    } else if (event.type === 'assistant/chunk') {
      const key = `${String(data?.turn)}:${String(data?.step)}`
      if (key !== chunkKey) { chunkKey = key; chunkText = '' }
      const chunk = record(data?.chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') chunkText += chunk.text
    }
  }
  return { text: finalText + chunkText, ended, reason }
}
