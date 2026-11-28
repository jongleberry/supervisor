export const POLICY_LIMITS = {
  maxPatternsPerRule: 256,
  maxOverridesPerRule: 16,
  maxOverridesPerFile: 128,
  maxRulesPerFile: 512,
  maxLocalsPerFile: 512,
  maxUseNames: 8,
  maxSeatSets: 8,
  maxResolutionSets: 16,
  maxTeamsPerList: 10,
  maxRepoClassifiersPerFile: 16,
  maxRepoRunsPerFile: 32,
  maxPurposeLength: 1000,
  maxConditionLength: 4096,
  maxParenDepth: 8,
  maxListEntries: 1024,
  maxFileBytes: 384 * 1024,
  maxRepoPolicyFiles: 1024,
  maxRepoTotalBytes: 8 * 1024 * 1024,
  minSeats: 0,
  maxSeats: 16,
  minSetCount: 1,
  maxSetCount: 16,
  minMaxAgeSeconds: 60,
  maxMaxAgeSeconds: 83 * 24 * 60 * 60,
} as const

export type PolicyMode = 'enforce' | 'observe'
export type NestedMode = 'overwrite' | 'inherit'
export type RunMode = 'sequential' | 'parallel'
export type ClaudeAction = 'approves' | 'comments' | 'blocks'
export type ReviewDepth = 'quick' | 'standard' | 'deep'
export type SeverityLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'critical'
export type DiffRating = 'trivial' | 'same_intent' | 'different'
export type ComparisonOp = '=' | '!=' | '<' | '<=' | '>' | '>='
export type Quantifier = 'ANY' | 'ALL'
export type TriBool = 'true' | 'false' | 'unknown'

export interface SeatSet {
  count: number
  from: string[]
}

export interface Verdict {
  claude: ClaudeAction
  seats: SeatSet[]
  maxAge?: string
}

export interface VerdictPatch {
  claude?: ClaudeAction
  seats?: SeatSet[]
  maxAge?: string | 'unset'
}

export interface ClassifierCall {
  name: string
  version?: number
  inputs: Record<string, string | number | string[]>
  output?: string
}

export type ConditionLhs =
  | { kind: 'fact'; name: string }
  | { kind: 'classifier'; call: ClassifierCall }

export type ConditionRhs =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'fact'; name: string }
  | { kind: 'list'; items: string[] }

export type ConditionExpr =
  | { kind: 'literal'; value: boolean }
  | { kind: 'logical'; op: 'AND' | 'OR'; items: ConditionExpr[] }
  | {
      kind: 'comparison'
      quantifier?: Quantifier
      lhs: ConditionLhs
      op: ComparisonOp
      rhs: ConditionRhs
    }

export interface ResolutionSet {
  if?: ConditionExpr
  from: string[]
}

export type ResolutionTarget = string[] | ResolutionSet[]

export interface FindingsSpec {
  resolution: 'unset' | ResolutionTarget | Record<string, ResolutionTarget>
}

export type ReuseValue = 'unset' | boolean | ConditionExpr
export type ReuseSpec = ReuseValue | Record<string, ReuseValue>

export interface PolicyOverride {
  if: ConditionExpr
  purpose?: string
  verdict?: VerdictPatch
  reuse?: ReuseSpec
  findings?: FindingsSpec
}

export interface PolicyRule {
  purpose: string
  paths: string[]
  mode: PolicyMode
  nested: NestedMode
  run: RunMode
  if: ConditionExpr
  verdict?: Verdict
  override: PolicyOverride[]
  advisory: ClassifierCall[]
  reuse?: ReuseSpec
  findings?: FindingsSpec
  sourceFile: string
  baseDir: string
}

export interface PolicyFile {
  path: string
  dir: string
  version: 1
  mode: PolicyMode
  nested: NestedMode
  run: RunMode
  locals: Record<string, unknown>
  rules: PolicyRule[]
  effectiveObserve: boolean
  /** Set on the supervisor policy when it is the root above a repository's own policy files. */
  supervisorRoot?: true
}

export interface PolicyValidationError {
  file: string
  path: string
  message: string
}

export class PolicyLoadError extends Error {
  readonly errors: PolicyValidationError[]

  constructor(errors: PolicyValidationError[]) {
    super(errors.map((err) => `${err.file}:${err.path}: ${err.message}`).join('\n'))
    this.name = 'PolicyLoadError'
    this.errors = errors
  }
}

export interface LoadPolicyOptions {
  supervisorPolicy?: boolean
  inheritedLocals?: Record<string, unknown>
  filePath?: string
  dir?: string
}

export type {
  AppliedRuleResult,
  ClassifierResult,
  EvaluatedSeat,
  EvaluationFacts,
  EvaluationInput,
  EvaluationResult,
  FileEvaluation,
  NextStep,
  StoppedAt,
  UnreadRule,
} from './eval-types.js'
