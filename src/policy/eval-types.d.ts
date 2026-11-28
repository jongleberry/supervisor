import type { ClaudeAction, ReviewDepth, SeatSet, Verdict } from './types.js'

export interface EvaluationFacts {
  filesChanged?: number
  filesAdded?: number
  filesRemoved?: number
  diffLines?: number
  authors?: string[]
  approvedBy?: string[]
  openedBy?: string
  base?: string
  repository?: string
  labels?: string[]
  teams?: Record<string, string[]>
  bots?: string[]
}

export interface ClassifierResult {
  status: 'complete' | 'error' | 'incomplete'
  value?: string | number
  level?: ReviewDepth
  severity?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'critical'
  outputs?: Record<string, string | number>
}

export interface EvaluationInput {
  changedFiles: string[]
  facts?: EvaluationFacts
  classifiers?: Record<string, ClassifierResult>
}

export interface EvaluatedSeat extends SeatSet {
  filledBy: string[]
  remaining: number
  authorOnly: boolean
}

/** Where reading a rule's overrides stopped because a classifier has no result. */
export interface StoppedAt {
  /** The override, counted from 1. */
  override: number
  missing: string[]
}

/** A rule whose own `if` could not be read because a classifier has no result. */
export interface UnreadRule {
  purpose: string
  sourceFile: string
  missing: string[]
}

export interface AppliedRuleResult {
  purpose: string
  sourceFile: string
  verdict: Verdict
  overrideIndex: number | null
  waitingOnClassifier: boolean
  authorOnlySeats: boolean
  /** Set when a missing classifier result stopped the overrides; the rule's own verdict stands. */
  stoppedAt?: StoppedAt
}

export interface FileEvaluation {
  file: string
  decidingPolicy: string | null
  covered: boolean
  /** True when no rule applied to this protected file, so its verdict and seats are the baseline. */
  protectedBaseline: boolean
  noRuleApplies: boolean
  unresolvedRuleIf: boolean
  /** Rules whose own `if` a missing classifier result left undecided. */
  ifNotRead?: UnreadRule[]
  rules: AppliedRuleResult[]
  verdict: ClaudeAction | null
  seats: EvaluatedSeat[]
  reviewDepth: ReviewDepth | null
}

export type NextStep =
  | { action: 'merge' }
  /** Request a final review of the head. `reason` is set when only bot seats are unmet. */
  | { action: 'request_review'; depth: ReviewDepth; reason?: string }
  | { action: 'escalate'; reason: string }
  /** The policy allows the merge but pr-shepherd says the PR is not ready: run pr-shepherd. */
  | { action: 'shepherd'; reason: string }
  /** Only classifier results that are missing keep a rule from a better verdict: collect them. */
  | { action: 'collect_classifiers'; missing: string[] }

export interface EvaluationResult {
  files: FileEvaluation[]
  uncoveredFiles: string[]
  verdict: ClaudeAction | null
  seats: EvaluatedSeat[]
  reviewDepth: ReviewDepth | null
  authorOnlyWarnings: string[]
  nextStep: NextStep
}
