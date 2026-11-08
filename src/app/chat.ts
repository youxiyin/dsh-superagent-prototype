/** Splitting of a general-assistant answer into Feishu-sized chat messages. */

/** Largest text one Feishu chat message carries; code fences are closed and reopened across the split. */
export const CHAT_CHARS = 3000
const FENCE = /^(\s*)(`{3,}|~{3,})([^`~]*)$/

/** The fence still open after `text`, starting from `open`: the marker of the opening line, or undefined between fences. */
function openFence(text: string, open: string | undefined): string | undefined {
  let fence = open
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) continue
    const marker = match[2]!
    if (fence === undefined) { fence = marker; continue }
    if (marker[0] === fence[0] && marker.length >= fence.length && match[3]!.trim() === '') fence = undefined
  }
  return fence
}

/**
 * Splits an assistant answer into messages whose text is at most `limit` characters, preferring paragraph, line, then word
 * boundaries. A code fence open at a split is closed at the end of one message and reopened at the start of the next, which
 * adds one fence line to each of those messages.
 * @param text - the assistant's answer.
 * @param limit - the largest answer text in one message, in characters.
 * @returns the messages in order; an empty answer yields none.
 */
export function splitChat(text: string, limit = CHAT_CHARS): string[] {
  const source = text.trim()
  if (!source) return []
  const chunks: string[] = []
  let start = 0
  let fence: string | undefined
  while (start < source.length) {
    let end = Math.min(source.length, start + limit)
    if (end < source.length) {
      // A fence marker split in two would read as prose on both sides.
      if (/[`~]/.test(source[end - 1] ?? '') && /[`~]/.test(source[end] ?? '')) {
        const lineEnd = source.indexOf('\n', end)
        if (lineEnd !== -1 && lineEnd - start <= limit * 2) end = lineEnd
      }
      for (const boundary of [source.lastIndexOf('\n\n', end), source.lastIndexOf('\n', end), source.lastIndexOf(' ', end)]) {
        if (boundary > start + Math.floor(limit / 2)) { end = boundary; break }
      }
    }
    const body = source.slice(start, end).trimEnd()
    const reopened = fence === undefined ? body : `${fence}\n${body}`
    const open = openFence(body, fence)
    chunks.push(open === undefined ? reopened : `${reopened}\n\`\`\``)
    fence = open
    start = end
    while (start < source.length && /\s/.test(source[start]!)) start++
  }
  return chunks.filter(chunk => chunk.trim() !== '')
}
