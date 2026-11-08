import { describe, expect, it } from 'vitest'
import type { Delegation, Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false
type Expect<T extends true> = T
type _State = Expect<Equal<Delegation['state'], 'carded' | 'running' | 'reported' | 'reviewing' | 'reviewed' | 'verdicted' | 'failed'>>
type _Role = Expect<Equal<Delegation['role'], 'builder' | 'reader' | 'mass'>>
type _Verdict = Expect<Equal<Delegation['verdict'], 'pass' | 'rework' | 'escalate' | 'close'>>
type _ReviewConclusion = Expect<Equal<Delegation['reviewConclusion'], 'pass' | 'rework' | 'unknown' | undefined>>
type _OverrideReason = Expect<Equal<Delegation['overrideReason'], string | undefined>>

describe('Delegation', () => {
  it('attaches a fully typed delegation to a ticket without requiring a display note', () => {
    const value: Delegation = {
      id: 'fix-button',
      chain: 'code',
      taskDir: '/work/ticket/.fleet/tasks/fix-button',
      role: 'builder',
      jobId: 'fleet-1',
      state: 'reviewed',
      producer: { worker: 'builder-worker', family: 'family-a', routeId: 'route-a', model: 'model-a' },
      critic: { worker: 'critic-worker', family: 'family-b' },
      reviewJobId: 'fleet-2',
      reviewConclusion: 'pass',
      verdict: 'pass',
      overrideReason: 'Documented residual risk.',
      reviewRounds: 1,
      errorClass: '',
      startedAt: '2026-11-05T00:00:00.000Z',
      endedAt: '2026-11-05T00:10:00.000Z',
    }
    const attached: Pick<Ticket, 'delegations'> = { delegations: [value] }
    expect(attached.delegations).toEqual([value])
  })
})

describe('fleet settings', () => {
  const defaults = {
    enabled: false,
    bin: 'fleet',
    timeoutMinutes: 180,
    reportMaxChars: 20000,
    allowedChains: ['code', 'complex'],
    delegationsPerTicket: 2,
    reviewRounds: 3,
    allowFree: false,
    freeMaterialSensitivity: [],
  }
  it('fills every default when fleet or its new fields are absent', () => {
    expect(SettingsSchema.parse({}).executor.fleet).toEqual(defaults)
    expect(SettingsSchema.parse({ executor: { fleet: { enabled: true } } }).executor.fleet).toEqual({ ...defaults, enabled: true })
  })
  it('preserves all nine configured fields', () => {
    const fleet = {
      enabled: true,
      bin: 'custom-fleet',
      timeoutMinutes: 60,
      reportMaxChars: 30000,
      allowedChains: ['bulk'],
      delegationsPerTicket: 4,
      reviewRounds: 5,
      allowFree: true,
      freeMaterialSensitivity: ['public'],
    }
    expect(SettingsSchema.parse({ executor: { fleet } }).executor.fleet).toEqual(fleet)
  })
  it('keeps the fleet settings strict', () => {
    expect(() => SettingsSchema.parse({ executor: { fleet: { unknown: true } } })).toThrow()
  })
})
