export interface Scope {
  owner: string
  kind: 'org' | 'user'
  repos: '*' | string[]
  excludeForks?: boolean
  excludedRepos?: string[]
  mode?: 'enforce' | 'report'
  provenance?: { fields: string[] }
  taxonomy?: { projectByRepo?: Record<string, string>; sensitiveIssueRepo?: string }
  checkoutRoot?: string
}

export interface StaleRuns {
  olderThan?: string
  cancelAfter?: string
}

export interface ScheduledPrompts {
  glob?: string
  prWrapper?: string
  issueWrapper?: string
  issueMarker?: string
  quota?: number
  history?: number
}

export interface EventWait {
  /** @deprecated Ignored; supervisor reads relay events with its bundled hook-harness client. */
  hookHarness?: string
  timeout?: string
  advance?: boolean
  updateCheckDelay?: string
}

export interface Labels {
  /** @deprecated Ignored; Phase B and default PR triage select open PRs by their provenance comment. */
  automation?: string
  needsHuman?: string
}

export interface SweepCap {
  issues?: number
  dispatches?: number
}

/** The configuration file as written; `schemas/config.json` is the source of truth. */
export interface SupervisorConfig {
  scopes: Scope[]
  provenance: { fields: string[] }
  mergeAuthority: {
    policy: string
    policyEngine: 'supervisor' | 'claude-approvals' | 'compare'
    attendedOnly: boolean
    hosts: string[]
    models: string[]
    requiredAlwaysHuman?: Array<{ name: string; samples: string[] }>
  }
  finalReview: {
    request: Array<'session' | 'label'>
    label?: string
    reviewer?: string
    status?: string
  }
  harness: string
  trustedLogins?: string[]
  stateDir?: string
  modelTiers?: { mechanical?: string; implementation?: string; review?: string }
  labels?: Labels
  escalationChannel?: string
  dependencyBot?: { author?: string; openPullRequestLimit?: number }
  lockfileDedupe?: { author?: string; branch?: string; workflow?: string }
  dispatchTargets?: Record<string, unknown>
  fallbackCron?: string
  lateReviewDays?: number
  fullRescanDays?: number
  layerCap?: number
  sweepCap?: SweepCap
  scheduledPrompts?: ScheduledPrompts
  staleRuns?: false | StaleRuns
  eventWait?: EventWait
  distill?: { sessionDays?: number; archive?: boolean }
}

/** The configuration after `~/` expansion, with every documented default filled in. */
export interface LoopConfig extends SupervisorConfig {
  fallbackCron: string
  lateReviewDays: number
  fullRescanDays: number
  layerCap: number
  sweepCap: Required<SweepCap>
  scheduledPrompts?: ScheduledPrompts & { quota: number; history: number }
  staleRuns: false | Required<StaleRuns>
  labels?: Omit<Labels, 'automation'>
  eventWait: Required<Omit<EventWait, 'hookHarness'>>
}
