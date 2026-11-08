/** Splitting of a long general-assistant answer into Feishu-sized chat messages. */
import { expect, it } from 'vitest'
import { splitChat } from '../src/app/chat.ts'

it('answers no messages for an empty answer and one for a short answer', () => {
  expect(splitChat(' \n\t ')).toEqual([])
  expect(splitChat('  Hello there\n')).toEqual(['Hello there'])
})

it('prefers a paragraph, then a line, then a word near the limit, and splits an unbroken run at the limit', () => {
  expect(splitChat(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  expect(splitChat('line one\nline two\nline three\nline four', 20)).toEqual(['line one\nline two', 'line three\nline four'])
  expect(splitChat('alpha beta gamma delta epsilon', 20)).toEqual(['alpha beta gamma', 'delta epsilon'])
  expect(splitChat('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

it('closes a code fence at a split and reopens it in the next message', () => {
  const code = '```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```'
  expect(splitChat(code, 20)).toEqual(['```ts\nconst a = 1\n```', '```\nconst b = 2\n```', '```\nconst c = 3\n```'])
})

it('keeps a fence marker whole when the limit falls inside it', () => {
  expect(splitChat('abcdefghijk\n```ts\nx\n```', 13)).toEqual(['abcdefghijk\n```ts\n```', '```\nx\n```'])
})
