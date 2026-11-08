import { describe, expect, it } from 'vitest'
import { assertFleetCard, parseFleetCard } from '../src/app/tools/fleet-card.ts'

interface CardOptions {
  taskType?: string
  sensitivity?: string
  modality?: string
  context?: string
  quality?: string
  latency?: string
  reasoning?: string
  free?: boolean
  acceptance?: string
  extraBudget?: string
  outside?: string
}

function makeCard(options: CardOptions = {}): string {
  const acceptance = options.acceptance ?? '```sh\npnpm typecheck\npnpm vitest run tests/fleet-card.spec.ts\n```'
  return `# 任务卡：测试\n\n${options.outside ?? ''}\n\n## 验收（明卷：逐条可执行命令 + 预期结果）\n${acceptance}\n\n## 预算与停止条件\n- 任务类型：${options.taskType ?? 'complex'}（code/complex/bulk/survey/zh-text/visual/structured/research）\n- 材料敏感度：${options.sensitivity ?? 'internal'}（public/internal/restricted）\n- 模态：${options.modality ?? 'text'}（text/image/video/computer）\n- 上下文需求：${options.context ?? '未声明'}（需要时写 token 正整数）\n- 质量级别：${options.quality ?? 'standard'}（standard/critical）\n- 时延目标：${options.latency ?? 'background'}（interactive/background）\n- 推理档位：${options.reasoning ?? 'default'}（按任务需要填写）\n${options.free ? '- 免费档：允许（需宿主配置授权）\n' : ''}${options.extraBudget ?? ''}`
}

const openFree = { allowFree: true, freeMaterialSensitivity: ['public'] }

describe('fleet card parser', () => {
  it('parses template-shaped fields, strips parentheses, and extracts sh acceptance commands', () => {
    const card = parseFleetCard(makeCard({
      sensitivity: 'public', free: true,
      acceptance: '```sh\npnpm typecheck\n```\n说明文字\n```sh\npnpm test\n```',
    }))
    expect(card).toMatchObject({
      taskType: 'complex', materialSensitivity: 'public', modality: 'text', contextRequirement: '未声明',
      qualityLevel: 'standard', latencyTarget: 'background', reasoningLevel: 'default', freeTier: true,
      acceptanceCommands: ['pnpm typecheck', 'pnpm test'], issues: [],
    })
  })

  it.each(['code', 'complex', 'bulk', 'survey', 'zh-text', 'visual'])('accepts supported task type %s and positive context', taskType => {
    const card = parseFleetCard(makeCard({ taskType, context: '1024' }))
    expect(card.issues).toEqual([])
    expect(card.contextRequirement).toBe('1024')
    expect(() => assertFleetCard(card, taskType, { allowFree: false, freeMaterialSensitivity: [] })).not.toThrow()
  })

  it('reports every missing required field and the acceptance block together', () => {
    const card = parseFleetCard('# 没有预算节或验收节')
    expect(card.issues.filter(issue => issue.kind === 'missing').map(issue => issue.field)).toEqual([
      '任务类型', '材料敏感度', '模态', '上下文需求', '质量级别', '时延目标', '推理档位', '验收',
    ])
    const failure = () => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })
    expect(failure).toThrow('卡契约校验失败')
    for (const field of ['任务类型', '材料敏感度', '模态', '上下文需求', '质量级别', '时延目标', '推理档位', '验收']) {
      expect(failure).toThrow(field)
    }
  })

  it.each(['任务类型', '材料敏感度', '模态', '上下文需求', '质量级别', '时延目标', '推理档位'])('rejects a card missing only %s', field => {
    const source = makeCard().split('\n').filter(line => !line.startsWith(`- ${field}：`)).join('\n')
    const card = parseFleetCard(source)
    expect(card.issues).toEqual([{ field, kind: 'missing', detail: '缺少必填字段或取值为空' }])
    expect(() => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })).toThrow(field)
  })

  it.each([
    { option: { taskType: 'structured' }, field: '任务类型' },
    { option: { sensitivity: 'secret' }, field: '材料敏感度' },
    { option: { modality: 'audio' }, field: '模态' },
    { option: { context: '0' }, field: '上下文需求' },
    { option: { context: '-1' }, field: '上下文需求' },
    { option: { context: '1.5' }, field: '上下文需求' },
  ])('rejects invalid field value $option', ({ option, field }) => {
    const card = parseFleetCard(makeCard(option))
    expect(card.issues).toEqual([expect.objectContaining({ field, kind: 'invalid' })])
    expect(() => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })).toThrow(field)
  })

  it('treats blank quality, latency and reasoning values as missing', () => {
    const card = parseFleetCard(makeCard({ quality: '', latency: '', reasoning: '' }))
    expect(card.issues).toEqual(expect.arrayContaining([
      { field: '质量级别', kind: 'missing', detail: '缺少必填字段或取值为空' },
      { field: '时延目标', kind: 'missing', detail: '缺少必填字段或取值为空' },
      { field: '推理档位', kind: 'missing', detail: '缺少必填字段或取值为空' },
    ]))
  })

  it('rejects duplicate and same-line fields instead of choosing a permissive value', () => {
    const duplicate = parseFleetCard(makeCard({ sensitivity: 'restricted', extraBudget: '- 材料敏感度：public\n' }))
    expect(duplicate.issues).toEqual([expect.objectContaining({ field: '材料敏感度', kind: 'invalid', detail: '字段重复出现' })])
    expect(duplicate.materialSensitivity).toBeUndefined()

    const sameLine = parseFleetCard(makeCard({ extraBudget: '- 材料敏感度：public - 免费档：允许\n' }))
    expect(sameLine.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '材料敏感度', kind: 'invalid', detail: '同一行出现多个字段' }),
      expect.objectContaining({ field: '免费档', kind: 'invalid', detail: '同一行出现多个字段' }),
    ]))
    expect(sameLine.freeTier).toBe(false)

    const duplicateFree = parseFleetCard(makeCard({ free: true, extraBudget: '- 免费档：禁止\n' }))
    expect(duplicateFree.issues).toEqual([expect.objectContaining({ field: '免费档', kind: 'invalid', detail: '字段重复出现' })])
    expect(duplicateFree.freeTier).toBe(false)
  })

  it('ignores misspelled fields and same-named prose outside the budget section', () => {
    const source = makeCard({ outside: '- 任务类型：code\n- 材料敏感度：public\n- 免费档：允许' })
      .replace('- 任务类型：complex', '- 任务类形：complex')
    const card = parseFleetCard(source)
    expect(card.taskType).toBeUndefined()
    expect(card.materialSensitivity).toBe('internal')
    expect(card.freeTier).toBe(false)
    expect(card.issues).toEqual([expect.objectContaining({ field: '任务类型', kind: 'missing' })])
    expect(() => assertFleetCard(card, 'complex', { allowFree: true, freeMaterialSensitivity: ['public', 'internal'] })).toThrow('任务类型')
  })

  it.each([
    { name: 'no fence', acceptance: 'pnpm test' },
    { name: 'another language', acceptance: '```bash\npnpm test\n```' },
    { name: 'empty sh fence', acceptance: '```sh\n  \n```' },
    { name: 'unclosed sh fence', acceptance: '```sh\npnpm test' },
  ])('requires a nonempty closed sh fence: $name', ({ acceptance }) => {
    const card = parseFleetCard(makeCard({ acceptance }))
    expect(card.acceptanceCommands).toEqual([])
    expect(card.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: '验收', kind: 'missing' })]))
  })
})

describe('fleet card run gates', () => {
  it('accepts a matching chain and names both values on mismatch', () => {
    const card = parseFleetCard(makeCard({ taskType: 'code' }))
    expect(() => assertFleetCard(card, 'code', { allowFree: false, freeMaterialSensitivity: [] })).not.toThrow()
    const failure = () => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })
    expect(failure).toThrow('任务类型不匹配')
    expect(failure).toThrow('card=code')
    expect(failure).toThrow('run=@complex')
  })

  it('allows a public free-tier card when enabled and whitelisted', () => {
    const card = parseFleetCard(makeCard({ sensitivity: 'public', free: true }))
    expect(() => assertFleetCard(card, 'complex', openFree)).not.toThrow()
  })

  it.each(['internal', 'restricted'])('hard-rejects %s free-tier material even when configuration includes it', sensitivity => {
    const card = parseFleetCard(makeCard({ sensitivity, free: true }))
    const failure = () => assertFleetCard(card, 'complex', { allowFree: sensitivity === 'restricted', freeMaterialSensitivity: [sensitivity] })
    expect(failure).toThrow('免费档硬拒绝')
    expect(failure).toThrow(sensitivity)
    expect(failure).not.toThrow('allowFree is off')
  })

  it.each(['internal', 'restricted'])('hard-rejects %s under every allowFree and whitelist combination', sensitivity => {
    const card = parseFleetCard(makeCard({ sensitivity, free: true }))
    for (const allowFree of [false, true]) {
      for (const freeMaterialSensitivity of [[], [sensitivity]]) {
        const config = { allowFree, freeMaterialSensitivity }
        expect(() => assertFleetCard(card, 'complex', config), JSON.stringify(config)).toThrow('免费档硬拒绝')
      }
    }
  })

  it('rejects public free tier when allowFree is off before checking the whitelist', () => {
    const card = parseFleetCard(makeCard({ sensitivity: 'public', free: true }))
    expect(() => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })).toThrow('executor.fleet.allowFree is off')
  })

  it('rejects public free tier outside the whitelist when enabled', () => {
    const card = parseFleetCard(makeCard({ sensitivity: 'public', free: true }))
    expect(() => assertFleetCard(card, 'complex', { allowFree: true, freeMaterialSensitivity: [] })).toThrow('executor.fleet.freeMaterialSensitivity')
  })

  it('does not apply free-tier configuration to a non-free internal card', () => {
    const card = parseFleetCard(makeCard({ sensitivity: 'internal' }))
    expect(() => assertFleetCard(card, 'complex', { allowFree: false, freeMaterialSensitivity: [] })).not.toThrow()
  })
})
