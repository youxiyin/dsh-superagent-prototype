/** Fleet delegation evidence: run meta, run directories, critic candidates, argv tightening and host options. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fleetArgv, withHostFleetOptions } from '../src/app/tools/fleet.ts'
import { attributeRunDir, knownRunDirs, parseCriticCandidates, parseReviewConclusion, readCriticCandidates, readReviewConclusion, readRunOutcome, recordDelegation, runDirFromStdout } from '../src/app/tools/fleet-delegation.ts'
import type { Delegation, Ticket } from '../src/core/model.ts'

const directory = mkdtempSync(join(tmpdir(), 'fleet-argv-'))
mkdirSync(join(directory, '.fleet', 'tasks', '20261105-fleet-tool-gate'), { recursive: true })
const task = join(directory, '.fleet', 'tasks', '20261105-fleet-tool-gate')

describe('fleetArgv chain types and host-only options', () => {
  it('refuses a named worker and accepts only a known chain type', () => {
    for (const worker of ['codex', 'kimi-k3-1-pro', '@review', '@structured', '@unknown', '@Code']) {
      expect(() => fleetArgv(['run', worker, task], directory)).toThrow('不要指名工人')
    }
    for (const chain of ['@code', '@complex', '@bulk', '@survey', '@zh-text', '@visual']) {
      expect(fleetArgv(['run', chain, task], directory)).toEqual(['run', chain, task])
    }
  })

  it('requires a non-empty one-line card title', () => {
    expect(() => fleetArgv(['card', directory, 'probe-slug'], directory)).toThrow('--title')
    expect(() => fleetArgv(['card', directory, 'probe-slug', '--title', ''], directory)).toThrow('--title')
    expect(() => fleetArgv(['card', directory, 'probe-slug', '--title', 'a\nb'], directory)).toThrow('--title')
    expect(fleetArgv(['card', directory, 'probe-slug', '--title', 'T'], directory)).toEqual(['card', directory, 'probe-slug', '--title', 'T'])
  })

  it('strips a model-supplied critic and producer family without requiring one', () => {
    expect(fleetArgv(['review', task], directory)).toEqual(['review', task])
    expect(fleetArgv(['review', task, '--critic', 'codex', '--producer-family', 'gpt'], directory)).toEqual(['review', task])
    expect(fleetArgv(['review', task, '--critic=codex', '--base', 'HEAD~1'], directory)).toEqual(['review', task, '--base', 'HEAD~1'])
    expect(withHostFleetOptions(['review', task], { '--critic': '@review' })).toEqual(['review', task, '--critic', '@review'])
  })

  it('keeps the other validations intact', () => {
    expect(() => fleetArgv(['run', '@code', join(directory, '.fleet', 'tasks', 'other')], directory)).toThrow()
    expect(() => fleetArgv(['verdict', task, 'maybe'], directory)).toThrow('verdict')
    expect(() => fleetArgv(['run', '@code', task, '--role', 'critic'], directory)).toThrow('role')
    expect(() => fleetArgv(['critics'], directory)).toThrow('Missing fleet option')
    expect(fleetArgv(['critics', '--producer-family', 'moonshot'], directory)).toEqual(['critics', '--producer-family', 'moonshot'])
  })

  it('accepts a non-empty one-line override reason verbatim and rejects invalid values and flags', () => {
    const reason = '  evidence supports the remaining risk  '
    expect(fleetArgv(['verdict', task, 'pass', '--override-reason', reason], directory))
      .toEqual(['verdict', task, 'pass', '--override-reason', reason])
    expect(fleetArgv(['verdict', task, 'pass', `--override-reason=${reason}`], directory))
      .toEqual(['verdict', task, 'pass', `--override-reason=${reason}`])
    for (const value of ['', ' \t ', 'a\nb', 'a\rb', 'a\0b']) {
      expect(() => fleetArgv(['verdict', task, 'pass', '--override-reason', value], directory)).toThrow()
    }
    expect(() => fleetArgv(['verdict', task, 'pass', '--override-reason'], directory)).toThrow()
    expect(() => fleetArgv(['verdict', task, 'pass', '--override-reasonx', 'value'], directory)).toThrow('not allowed')
  })
})

describe('review conclusion evidence', () => {
  it('parses pass and rework conclusions with rework winning every conflict', () => {
    expect(parseReviewConclusion('## 结论：通过\n没有发现问题')).toBe('pass')
    expect(parseReviewConclusion('## 结论：需返工\n有问题')).toBe('rework')
    expect(parseReviewConclusion('## 结论：返工')).toBe('rework')
    expect(parseReviewConclusion('## 结论：通过\n## 结论：需返工')).toBe('rework')
    expect(parseReviewConclusion('## 结论：返工\n## 结论：通过')).toBe('rework')
  })

  it('normalizes headings, whitespace, colons and emphasis around the line and value', () => {
    expect(parseReviewConclusion('  ### **结论 ： 通过**')).toBe('pass')
    expect(parseReviewConclusion('## *结论: 需返工*')).toBe('rework')
    expect(parseReviewConclusion('_结论：返工_')).toBe('rework')
    expect(parseReviewConclusion('## 结论：**通过**')).toBe('pass')
    expect(parseReviewConclusion('## 结论： *需返工* ')).toBe('rework')
    expect(parseReviewConclusion('## 结论：_返工_')).toBe('rework')
  })

  it('ignores malformed labels and non-exact or empty conclusion values', () => {
    for (const input of ['## 结论 通过', '## 总结：通过', '## 结论：', '## 结论：通过。', '## 结论：建议返工']) {
      expect(parseReviewConclusion(input), input).toBe('unknown')
    }
  })

  it.each([
    ['不通过', '## 结论：不通过'],
    ['未通过', '## 结论：未通过'],
    ['不建议通过', '## 结论：不建议通过'],
    ['无需返工', '## 结论：无需返工'],
    ['模板原文', '## 结论：通过 / 需返工'],
    ['附条件通过', '## 结论：通过（附条件）'],
    ['正文含通过但无结论行', '## 问题\n这段代码可以通过测试'],
  ])('rejects negated, reserved, template, conditional, and body-only text: %s', (_label, input) => {
    expect(parseReviewConclusion(input)).toBe('unknown')
  })

  it('returns unknown without a conclusion line or a readable review file', () => {
    expect(parseReviewConclusion('通过\n需返工')).toBe('unknown')
    expect(parseReviewConclusion('## 问题\n尚未形成结论')).toBe('unknown')
    const root = mkdtempSync(join(tmpdir(), 'fleet-review-conclusion-'))
    expect(readReviewConclusion(root)).toBe('unknown')
    writeFileSync(join(root, 'review.md'), '## 结论：通过\n')
    expect(readReviewConclusion(root)).toBe('pass')
  })
})

describe('run outcome and critic evidence', () => {
  it('reads an explicit run, never falls back to the newest run, and reports a missing meta as unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-delegation-'))
    const older = join(root, 'runs', '20261105-230000-codex-builder')
    const newer = join(root, 'runs', '20261105-230120-kimi-k3-1-pro-builder')
    mkdirSync(older, { recursive: true }); mkdirSync(newer, { recursive: true })
    writeFileSync(join(older, 'meta.json'), JSON.stringify({ status: 'done', worker: 'codex', family: 'gpt', report_exists: true }))
    writeFileSync(join(newer, 'meta.json'), JSON.stringify({ status: 'done', worker: 'kimi-k3-1-pro', family: 'moonshot',
      role: 'builder', report_exists: true, error_class: '', route_id: 'r1', model: 'm1' }))
    expect(readRunOutcome(root, newer)).toMatchObject({ worker: 'kimi-k3-1-pro', family: 'moonshot', status: 'done',
      reportExists: true, routeId: 'r1', model: 'm1', role: 'builder' })
    expect(readRunOutcome(root)).toEqual({ worker: '', family: '', status: 'unknown', errorClass: 'missing-run-dir', reportExists: false })
    expect(readRunOutcome(join(root, 'absent'), join(root, 'absent'))).toEqual({ worker: '', family: '', status: 'unknown', errorClass: 'missing-meta', reportExists: false })
    const broken = join(root, 'runs', '20261105-230200-codex-builder'); mkdirSync(broken)
    writeFileSync(join(broken, 'meta.json'), 'not json')
    expect(readRunOutcome(root, broken)).toMatchObject({ status: 'unknown', errorClass: 'missing-meta' })
  })

  it('attributes only a fresh run directory under the task runs folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-rework-'))
    const fresh = join(root, 'runs', '20261106-101010-kimi-k3-1-pro-builder')
    const stale = join(root, 'runs', '20261105-230000-codex-builder')
    const outside = mkdtempSync(join(tmpdir(), 'fleet-outside-'))
    mkdirSync(fresh, { recursive: true }); mkdirSync(stale, { recursive: true })
    const known = new Set(['20261105-230000-codex-builder'])
    expect(knownRunDirs(root)).toEqual(new Set(['20261106-101010-kimi-k3-1-pro-builder', '20261105-230000-codex-builder']))
    expect(attributeRunDir(root, fresh, known)).toBe(realpathSync(fresh))
    expect(attributeRunDir(root, stale, known)).toBeUndefined()
    expect(attributeRunDir(root, outside, known)).toBeUndefined()
    expect(attributeRunDir(root, undefined, known)).toBeUndefined()
  })

  it('accepts only a fresh direct child of runs and returns its verified real path', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-nested-'))
    const runs = join(root, 'runs'), old = join(runs, 'old'), nested = join(old, 'cached')
    const fresh = join(runs, '20261106-120000-codex-builder')
    mkdirSync(nested, { recursive: true })
    const known = new Set(['old'])
    // A nested historical directory is not a direct child of runs.
    expect(attributeRunDir(root, nested, known)).toBeUndefined()
    mkdirSync(fresh, { recursive: true })
    expect(attributeRunDir(root, fresh, known)).toBe(realpathSync(fresh))
    // A direct child already in the dispatch-time snapshot was not produced by this dispatch.
    expect(attributeRunDir(root, old, known)).toBeUndefined()
    expect(attributeRunDir(root, undefined, known)).toBeUndefined()
    expect(attributeRunDir(root, join(runs, 'absent'), known)).toBeUndefined()
  })

  it('takes the last existing run directory from a run result line', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-stdout-'))
    const first = join(root, 'first'), second = join(root, 'second')
    mkdirSync(first); mkdirSync(second)
    expect(runDirFromStdout(`done｜1.20 秒｜report.md 有｜${first}\ndone｜2.00 秒｜report.md 有｜${second}`)).toBe(second)
    expect(runDirFromStdout(`done｜1.20 秒｜report.md 有｜${join(root, 'missing')}`)).toBeUndefined()
    expect(runDirFromStdout('no run line')).toBeUndefined()
  })

  it('parses critic candidates, skipping the title, an empty list and stale rows', () => {
    expect(parseCriticCandidates('评审证据（生产族 moonshot；过期仅诊断，不可派）：\n（无）')).toEqual([])
    expect(parseCriticCandidates('评审证据（生产族 moonshot；过期仅诊断，不可派）：\ncodex｜family=gpt｜pool=codex-chatgpt｜critic自检=ok\nold｜family=zhipu｜pool=p｜critic自检=ok｜过期'))
      .toEqual([{ worker: 'codex', family: 'gpt' }])
  })

  it('refuses a review when no fresh critic exists', async () => {
    await expect(readCriticCandidates('fleet', 'moonshot', directory, async () => '评审证据（生产族 moonshot）：\n（无）'))
      .rejects.toThrow('当前没有可派的不同家族评审者')
    expect(await readCriticCandidates('fleet', 'moonshot', directory, async (bin, args, cwd) => {
      expect([bin, ...args, cwd]).toEqual(['fleet', 'critics', '--producer-family', 'moonshot', directory])
      return '评审证据（生产族 moonshot）：\ncodex｜family=gpt｜pool=p｜critic自检=ok'
    })).toEqual([{ worker: 'codex', family: 'gpt' }])
  })
})

describe('recordDelegation', () => {
  const delegation: Delegation = {
    id: 'card', chain: '@code', taskDir: '/tmp/card', role: 'builder', jobId: 'fleet-1', state: 'reported',
    producer: { worker: 'kimi-k3-1-pro', family: 'moonshot' }, critic: { worker: '', family: '' },
    reviewJobId: '', verdict: '' as Delegation['verdict'], reviewRounds: 0, errorClass: '', startedAt: 'now', endedAt: 'now',
  }
  const ticket = { id: 't1', delegations: undefined } as unknown as Ticket
  const store = {
    value: ticket,
    tickets: {
      get: (id: string) => id === 't1' ? (store.value as Ticket) : undefined,
      save: (next: Ticket) => { store.value = next },
    },
  }

  it('appends a new delegation and replaces the same one', () => {
    recordDelegation({ store }, 't1', delegation)
    expect((store.value.delegations ?? []).map(item => item.state)).toEqual(['reported'])
    recordDelegation({ store }, 't1', { ...delegation, state: 'reviewed', critic: { worker: 'codex', family: 'gpt' } })
    expect(store.value.delegations).toEqual([{ ...delegation, state: 'reviewed', critic: { worker: 'codex', family: 'gpt' } }])
    expect(existsSync('/tmp/card')).toBe(false)
  })
})
