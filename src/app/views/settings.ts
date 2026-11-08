/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

const exec = promisify(execFile)
export const FLEET_STATS_TIMEOUT_MS = 1500
export const FLEET_STATS_CACHE_TTL_MS = 30_000
const FLEET_STATS_MAX_BUFFER = 64 * 1024
export interface FleetStatsView { summary: string | null }
export type FleetStatsReader = (bin: string) => Promise<FleetStatsView>
type FleetStatsRunner = (bin: string, args: string[], options: { timeout: number; maxBuffer: number; killSignal: 'SIGKILL' }) =>
  Promise<{ stdout: string }>
const runStats: FleetStatsRunner = async (bin, args, options) => exec(bin, args, { ...options, encoding: 'utf8' })
/** Reads fleet's own cost summary; an unavailable, empty, oversized or slow answer is unknown rather than a zero cost. */
export async function fleetStats(bin: string, run: FleetStatsRunner = runStats): Promise<FleetStatsView> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(bin, ['stats'], { timeout: FLEET_STATS_TIMEOUT_MS, maxBuffer: FLEET_STATS_MAX_BUFFER, killSignal: 'SIGKILL' })
        .then(({ stdout }) => ({ summary: stdout.trim() || null })).catch(() => ({ summary: null })),
      new Promise<FleetStatsView>(resolve => { deadline = setTimeout(() => resolve({ summary: null }), FLEET_STATS_TIMEOUT_MS) }),
    ])
  } catch { return { summary: null } }
  finally { if (deadline) clearTimeout(deadline) }
}
/** Caches one bin's stats per server and shares its background refresh; stale or unavailable data is reported as unknown. */
export function createFleetStatsCache(read: FleetStatsReader = fleetStats): (bin: string) => FleetStatsView {
  let cached: { bin: string; stats: FleetStatsView; expiresAt: number } | undefined
  let pending: Promise<void> | undefined
  return bin => {
    const current = cached?.bin === bin && cached.expiresAt > Date.now() ? cached : undefined
    if (!current && !pending) {
      const expires = () => Date.now() + FLEET_STATS_CACHE_TTL_MS
      pending = Promise.resolve().then(() => read(bin)).then(
        stats => { cached = { bin, stats, expiresAt: expires() } },
        () => { cached = { bin, stats: { summary: null }, expiresAt: expires() } },
      ).finally(() => { pending = undefined })
    }
    return current?.stats ?? { summary: null }
  }
}

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string,
  stats?: FleetStatsView) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    ...stats ? { stats } : {},
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.id] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
