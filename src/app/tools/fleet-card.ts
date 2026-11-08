/** Parse and enforce the host-side fleet card contract without changing the card. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const requiredFields = ['任务类型', '材料敏感度', '模态', '上下文需求', '质量级别', '时延目标', '推理档位'] as const
const knownFields = [...requiredFields, '免费档'] as const
type RequiredField = typeof requiredFields[number]
type KnownField = typeof knownFields[number]

export interface FleetCardIssue {
  field: string
  kind: 'missing' | 'invalid'
  detail: string
}

export interface FleetCard {
  taskType?: string
  materialSensitivity?: string
  modality?: string
  contextRequirement?: string
  qualityLevel?: string
  latencyTarget?: string
  reasoningLevel?: string
  freeTier: boolean
  acceptanceCommands: string[]
  issues: FleetCardIssue[]
}

export interface FreeTierPolicy {
  allowFree: boolean
  freeMaterialSensitivity: readonly string[]
}

const fieldPattern = /(?:^|\s)-\s*(任务类型|材料敏感度|模态|上下文需求|质量级别|时延目标|推理档位|免费档)\s*[：:]/g
const allowed: Partial<Record<RequiredField, readonly string[]>> = {
  任务类型: ['code', 'complex', 'bulk', 'survey', 'zh-text', 'visual'],
  材料敏感度: ['public', 'internal', 'restricted'],
  模态: ['text', 'image', 'video', 'computer'],
}

/** Remove one trailing explanatory parenthesis before comparing a field value. */
function fieldValue(raw: string): string {
  return raw.trim().replace(/\s*(?:（[^（）]*）|\([^()]*\))\s*$/, '').trim()
}

/** Parse only budget-section fields and acceptance-section sh fences; free prose contributes nothing. */
export function parseFleetCard(markdown: string): FleetCard {
  const values = new Map<KnownField, string[]>()
  const malformed = new Map<KnownField, string[]>()
  const acceptanceCommands: string[] = []
  let section: 'budget' | 'acceptance' | 'other' = 'other'
  let fence: { acceptance: boolean; sh: boolean; lines: string[] } | undefined

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (fence) {
      if (/^```\s*$/.test(line)) {
        const command = fence.lines.join('\n').trim()
        if (fence.acceptance && fence.sh && command) acceptanceCommands.push(command)
        fence = undefined
      } else if (fence.acceptance && fence.sh) fence.lines.push(raw)
      continue
    }
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]
    if (heading !== undefined) {
      section = heading === '预算与停止条件' ? 'budget' : heading.startsWith('验收') ? 'acceptance' : 'other'
      continue
    }
    const opening = /^```([^\s`]*)\s*$/.exec(line)
    if (opening) {
      fence = { acceptance: section === 'acceptance', sh: opening[1] === 'sh', lines: [] }
      continue
    }
    if (section !== 'budget') continue

    const occurrences = [...line.matchAll(fieldPattern)]
    if (occurrences.length > 1) {
      for (const occurrence of occurrences) {
        const field = occurrence[1] as KnownField
        malformed.set(field, [...(malformed.get(field) ?? []), '同一行出现多个字段'])
      }
      continue
    }
    const match = /^-\s*([^：:]+)[：:](.*)$/.exec(line)
    const field = match?.[1]?.trim() as KnownField | undefined
    if (!field || !knownFields.includes(field) || occurrences.length !== 1) continue
    values.set(field, [...(values.get(field) ?? []), fieldValue(match![2]!)])
  }

  const parsed: Partial<Record<RequiredField, string>> = {}
  const issues: FleetCardIssue[] = []
  for (const field of requiredFields) {
    const entries = values.get(field) ?? []
    const invalidLines = malformed.get(field) ?? []
    if (invalidLines.length || entries.length > 1) {
      const detail = [...invalidLines, ...(entries.length > 1 ? ['字段重复出现'] : [])].join('；')
      issues.push({ field, kind: 'invalid', detail })
      continue
    }
    const value = entries[0]?.trim() ?? ''
    if (!value) {
      issues.push({ field, kind: 'missing', detail: '缺少必填字段或取值为空' })
      continue
    }
    parsed[field] = value
    if (field === '上下文需求') {
      if (value !== '未声明' && !/^[1-9]\d*$/.test(value)) {
        issues.push({ field, kind: 'invalid', detail: `取值 ${value} 不是「未声明」或正整数` })
      }
    } else if (allowed[field] && !allowed[field]!.includes(value)) {
      issues.push({ field, kind: 'invalid', detail: `取值 ${value} 不在允许集合 ${allowed[field]!.join('/')} 中` })
    }
  }

  const freeEntries = values.get('免费档') ?? []
  const freeMalformed = malformed.get('免费档') ?? []
  let freeTier = false
  if (freeMalformed.length || freeEntries.length > 1) {
    const detail = [...freeMalformed, ...(freeEntries.length > 1 ? ['字段重复出现'] : [])].join('；')
    issues.push({ field: '免费档', kind: 'invalid', detail })
  } else freeTier = freeEntries[0] === '允许'
  if (!acceptanceCommands.length) {
    issues.push({ field: '验收', kind: 'missing', detail: '验收段至少需要一个非空、闭合的 ```sh 围栏块' })
  }

  return {
    ...(parsed.任务类型 ? { taskType: parsed.任务类型 } : {}),
    ...(parsed.材料敏感度 ? { materialSensitivity: parsed.材料敏感度 } : {}),
    ...(parsed.模态 ? { modality: parsed.模态 } : {}),
    ...(parsed.上下文需求 ? { contextRequirement: parsed.上下文需求 } : {}),
    ...(parsed.质量级别 ? { qualityLevel: parsed.质量级别 } : {}),
    ...(parsed.时延目标 ? { latencyTarget: parsed.时延目标 } : {}),
    ...(parsed.推理档位 ? { reasoningLevel: parsed.推理档位 } : {}),
    freeTier,
    acceptanceCommands,
    issues,
  }
}

/** Read a card; an unreadable file is invalid input and can never bypass a later gate. */
export function readFleetCard(taskDir: string): FleetCard {
  try { return parseFleetCard(readFileSync(join(taskDir, 'card.md'), 'utf8')) }
  catch {
    const card = parseFleetCard('')
    card.issues.unshift({ field: 'card.md', kind: 'invalid', detail: '无法读取卡片文件' })
    return card
  }
}

/** Reject an invalid card, a chain mismatch, or a free-tier request that policy cannot authorize. */
export function assertFleetCard(card: FleetCard, chain: string, config: FreeTierPolicy): void {
  if (card.issues.length) {
    const details = card.issues.map(issue => `- ${issue.kind === 'missing' ? '缺少' : '非法'} ${issue.field}：${issue.detail}`)
    throw new Error(`Fleet card contract rejected (卡契约校验失败):\n${details.join('\n')}`)
  }
  if (card.taskType !== chain) {
    throw new Error(`Fleet card task type mismatch (任务类型不匹配): card=${card.taskType}, run=@${chain}`)
  }
  if (!card.freeTier) return
  if (card.materialSensitivity === 'internal' || card.materialSensitivity === 'restricted') {
    throw new Error(`The card asks for the free tier, but ${card.materialSensitivity} material never uses free channels (免费档硬拒绝：internal/restricted 材料一律拒绝)`)
  }
  if (!config.allowFree) throw new Error('The card asks for the free tier, but executor.fleet.allowFree is off')
  if (!config.freeMaterialSensitivity.includes(card.materialSensitivity!)) {
    throw new Error(`The card asks for the free tier, but its material sensitivity (${card.materialSensitivity ?? 'missing'}) is not in executor.fleet.freeMaterialSensitivity`)
  }
}
