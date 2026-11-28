import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LoopConfig, SupervisorConfig } from './types.js'

/** How many scheduled prompts a sweep runs when `scheduledPrompts.quota` is not set. */
export const DEFAULT_PROMPT_QUOTA = 1

/** How many scheduled-prompt runs state keeps when `scheduledPrompts.history` is not set. */
export const DEFAULT_PROMPT_HISTORY = 20

/** Refuse `scheduledPrompts.history < quota`, which could evict an unfinished rotation's runs. */
export function scheduledPromptsHistoryError(
  scheduledPrompts: SupervisorConfig['scheduledPrompts'],
): string | undefined {
  if (scheduledPrompts === undefined) {
    return undefined
  }
  const quota = scheduledPrompts.quota ?? DEFAULT_PROMPT_QUOTA
  const history = scheduledPrompts.history ?? DEFAULT_PROMPT_HISTORY
  return history < quota ? `must be >= quota (${quota}), got ${history}` : undefined
}

/** Default per-sweep caps in enforce mode when `sweepCap` or either member is not set. */
export const DEFAULT_SWEEP_CAP = { issues: 10, dispatches: 5 } as const

/** A leading `~/` (or a bare `~`) means the home directory. */
export function expandHome(value: string): string {
  if (value === '~') {
    return homedir()
  }
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/** Expand `~/` in the path values and fill in every documented default. */
export function applyDefaults(raw: SupervisorConfig): LoopConfig {
  const { scheduledPrompts, staleRuns, stateDir, eventWait, sweepCap, labels, ...rest } = raw
  const { hookHarness: _ignored, ...wait } = eventWait ?? {}
  const { automation: _ignoredAutomation, ...activeLabels } = labels ?? {}
  return {
    ...rest,
    ...(labels === undefined ? {} : { labels: activeLabels }),
    scopes: raw.scopes.map((scope) =>
      scope.checkoutRoot === undefined
        ? scope
        : { ...scope, checkoutRoot: expandHome(scope.checkoutRoot) },
    ),
    ...(stateDir === undefined ? {} : { stateDir: expandHome(stateDir) }),
    fallbackCron: raw.fallbackCron ?? '0 */6 * * *',
    lateReviewDays: raw.lateReviewDays ?? 14,
    fullRescanDays: raw.fullRescanDays ?? 7,
    layerCap: raw.layerCap ?? 10,
    sweepCap: {
      issues: sweepCap?.issues ?? DEFAULT_SWEEP_CAP.issues,
      dispatches: sweepCap?.dispatches ?? DEFAULT_SWEEP_CAP.dispatches,
    },
    ...(scheduledPrompts === undefined
      ? {}
      : {
          scheduledPrompts: {
            quota: DEFAULT_PROMPT_QUOTA,
            history: DEFAULT_PROMPT_HISTORY,
            ...scheduledPrompts,
          },
        }),
    staleRuns: staleRuns === false ? false : { olderThan: '6h', cancelAfter: '24h', ...staleRuns },
    eventWait: {
      timeout: '2h',
      advance: false,
      updateCheckDelay: '10m',
      ...wait,
    },
  }
}
