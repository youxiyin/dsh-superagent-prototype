/** Readers that recover a general-assistant answer from its Session's event log. */
import { expect, it } from 'vitest'
import { activeTurn, collectAssistantTurn, findUserMessage, latestLocalRequest, turnOfMessage, type TurnEvent } from '../src/app/turn.ts'

const at = (seq: number, type: string, data: unknown): TurnEvent => ({ seq, type, data })

it('finds the message delivered under an id only at or after the baseline', () => {
  const events = [at(0, 'user/message', { id: 'early' }), at(1, 'turn/start', { turn: 1 }),
    at(2, 'user/message', { id: 'target' }), at(3, 'user/message', null)]
  expect(findUserMessage(events, 'early')).toBe(0)
  expect(findUserMessage(events, 'target')).toBe(2)
  expect(findUserMessage(events, 'target', 2)).toBe(2)
  expect(findUserMessage(events, 'target', 3)).toBeUndefined()
  expect(findUserMessage(events, 'missing')).toBeUndefined()
})

it('reads the latest local person request and skips runtime notices after it', () => {
  const events = [at(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'First' }] }),
    at(1, 'user/message', { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'Job ended' }] }),
    at(2, 'user/message', { source: { kind: 'user' },
      content: [{ type: 'image' }, null, { type: 'text' }, { type: 'text', text: ' second' }] })]
  expect(latestLocalRequest(events)).toBe(' second')
  expect(latestLocalRequest([at(0, 'user/message', { source: { kind: 'user' } })])).toBeUndefined()
  expect(latestLocalRequest([at(0, 'user/message', { content: [{ type: 'text', text: 'no source' }] })])).toBeUndefined()
})

it('stops at a non-local request or an empty one', () => {
  expect(latestLocalRequest([at(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
    at(1, 'user/message', { source: { kind: 'dsh-superagent' }, content: [{ type: 'text', text: 'card' }] })])).toBeUndefined()
  expect(latestLocalRequest([at(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '  ' }] })])).toBeUndefined()
  expect(latestLocalRequest([])).toBeUndefined()
})

it('names the turn that owns a message from the nearest boundary before it, or the one it opens', () => {
  const events = [at(0, 'turn/start', { turn: 4 }), at(1, 'step/start', { turn: 4, step: 1 }), at(2, 'user/message', { id: 'm' }),
    at(3, 'step/start', { turn: 4, step: 2 }), at(4, 'turn/end', { turn: 4 })]
  expect(turnOfMessage(events, 2)).toBe(4)
  expect(turnOfMessage(events, 4)).toBe(4)
  // A message recorded before the turn it opens takes the boundary after it.
  expect(turnOfMessage([at(0, 'user/message', { id: 'm' }), at(1, 'turn/start', { turn: 7 })], 0)).toBe(7)
  expect(turnOfMessage([at(0, 'turn/start', { turn: 'seven' }), at(1, 'user/message', { id: 'm' })], 1)).toBeUndefined()
  expect(turnOfMessage([], 0)).toBeUndefined()
})

it('reports the turn between its start and its end', () => {
  const start = at(0, 'turn/start', { turn: 1 }), end = at(1, 'turn/end', { turn: 1 })
  expect(activeTurn([])).toBeUndefined()
  expect(activeTurn([start])).toBe(1)
  expect(activeTurn([start, end])).toBeUndefined()
  expect(activeTurn([start, end, at(2, 'turn/start', { turn: 2 })])).toBe(2)
  expect(activeTurn([start, at(1, 'turn/end', { turn: 2 })])).toBe(1)
})

it('reads the latest settled assistant message of a turn and stops reading at its end', () => {
  const events = [at(0, 'turn/start', { turn: 1 }), at(1, 'user/message', { id: 'm' }), at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'text', text: 'First' }, { type: 'tool_use' }, { type: 'text', text: ' try' }] } }),
    at(4, 'step/start', { turn: 1, step: 2 }),
    at(5, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Final' }] } }),
    at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), at(7, 'turn/start', { turn: 2 }),
    at(8, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'Later' } })]
  expect(collectAssistantTurn(events, 1, 1)).toEqual({ text: 'Final', ended: true, reason: { kind: 'completed' } })
  expect(collectAssistantTurn(events, 1, 2)).toEqual({ text: 'Later', ended: false, reason: undefined })
})

it('streams the running step\'s deltas and restarts them when a message settles or the step changes', () => {
  const events = [at(0, 'turn/start', { turn: 3 }), at(1, 'user/message', { id: 'm' }),
    at(2, 'assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', text: 'Hel' } }),
    at(3, 'assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', text: 'lo' } }),
    at(4, 'assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: 'Hello!' }] } }),
    at(5, 'assistant/chunk', { turn: 3, step: 2, chunk: { type: 'text-delta', text: ' Bye' } })]
  expect(collectAssistantTurn(events, 1, 3)).toMatchObject({ text: 'Hello! Bye', ended: false })
  // A tool-only message keeps the earlier settled text, and the next step's deltas start from nothing.
  const toolOnly = [at(0, 'turn/start', { turn: 4 }), at(1, 'user/message', { id: 'm' }),
    at(2, 'assistant/chunk', { turn: 4, step: 1, chunk: { type: 'text-delta', text: 'hidden' } }),
    at(3, 'assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'tool_use' }] } }),
    at(4, 'assistant/chunk', { turn: 4, step: 2, chunk: { type: 'text-delta', text: 'shown' } })]
  expect(collectAssistantTurn(toolOnly, 1, 4).text).toBe('shown')
})

it('ignores events before the anchor and other turns', () => {
  const anchored = [at(0, 'turn/start', { turn: 2 }),
    at(1, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'older' }] } }),
    at(2, 'user/message', { id: 'm' }),
    at(3, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'new' }] } })]
  expect(collectAssistantTurn(anchored, 2, 2).text).toBe('new')
  const other = [at(0, 'turn/start', { turn: 9 }), at(1, 'user/message', { id: 'm' }),
    at(2, 'assistant/message', { turn: 9, message: { content: [{ type: 'text', text: 'other' }] } }),
    at(3, 'turn/end', { turn: 9, reason: 'stop' })]
  expect(collectAssistantTurn(other, 1, 1)).toEqual({ text: '', ended: false, reason: undefined })
})
