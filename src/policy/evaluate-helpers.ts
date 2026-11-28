import { extractClassifierCalls } from './condition-validate.js'
import { evaluateCondition } from './conditions.js'
import { missingClassifiers } from './missing-classifiers.js'
import { DEPTH_RANK, accountMatchesList } from './people.js'
import type {
  ClassifierResult,
  ClaudeAction,
  EvaluatedSeat,
  EvaluationFacts,
  NextStep,
  PolicyRule,
  ReviewDepth,
  SeatSet,
  StoppedAt,
  Verdict,
} from './types.js'

const CLAUDE_STRICTNESS: Record<ClaudeAction, number> = {
  approves: 1,
  comments: 2,
  blocks: 3,
}

export function strictestClaude(a: ClaudeAction | null, b: ClaudeAction): ClaudeAction {
  if (!a) return b
  return CLAUDE_STRICTNESS[b] > CLAUDE_STRICTNESS[a] ? b : a
}

export function maxDepth(a: ReviewDepth | null, b: ReviewDepth | null): ReviewDepth | null {
  if (!a) return b
  if (!b) return a
  return DEPTH_RANK[b] > DEPTH_RANK[a] ? b : a
}

export function ruleReviewDepth(rule: PolicyRule): ReviewDepth | null {
  const calls = [
    ...extractClassifierCalls(rule.if),
    ...rule.override.flatMap((o) => extractClassifierCalls(o.if)),
    ...rule.advisory,
  ]
  let depth: ReviewDepth | null = null
  for (const call of calls) {
    if (call.name === 'claude/code_review' && typeof call.inputs.level === 'string') {
      depth = maxDepth(depth, call.inputs.level as ReviewDepth)
    }
  }
  return depth
}

function isAuthorOnlySeat(set: SeatSet, facts: EvaluationFacts): boolean {
  if (set.count > 1) return false
  const authorAccount = facts.openedBy ?? facts.authors?.[0] ?? '__author__'
  const syntheticFacts: EvaluationFacts = {
    ...facts,
    openedBy: facts.openedBy ?? authorAccount,
    authors: facts.authors && facts.authors.length > 0 ? facts.authors : [authorAccount],
  }
  return accountMatchesList(authorAccount, set.from, syntheticFacts)
}

export function evaluateSeat(set: SeatSet, facts: EvaluationFacts): EvaluatedSeat {
  const authorOnly = isAuthorOnlySeat(set, facts)
  const candidates = new Set<string>()
  const authorAccount = facts.openedBy ?? facts.authors?.[0]
  if (authorAccount) candidates.add(authorAccount)
  for (const approver of facts.approvedBy ?? []) candidates.add(approver)

  const filledBy: string[] = []
  for (const account of candidates) {
    if (accountMatchesList(account, set.from, facts)) filledBy.push(account)
  }
  return {
    count: set.count,
    from: set.from,
    filledBy,
    remaining: Math.max(0, set.count - filledBy.length),
    authorOnly,
  }
}

export function evaluateRuleVerdict(
  rule: PolicyRule,
  facts: EvaluationFacts,
  ruleFilesChanged: number,
  classifiers: Record<string, ClassifierResult>,
): {
  verdict: Verdict
  overrideIndex: number | null
  waitingOnCodeReview: boolean
  stoppedAt?: StoppedAt
} {
  const base = rule.verdict!
  const ctx = {
    facts,
    ruleFacts: { filesChanged: ruleFilesChanged, filesAdded: ruleFilesChanged, filesRemoved: 0 },
    classifiers,
  }
  for (let i = 0; i < rule.override.length; i += 1) {
    const ov = rule.override[i]!
    const res = evaluateCondition(ov.if, ctx)
    if (res === 'false') continue
    if (res === 'unknown') {
      const waitingOnCodeReview = extractClassifierCalls(ov.if).some(
        (c) => c.name === 'claude/code_review',
      )
      const unread = missingClassifiers(ov.if, classifiers)
      // `override` counts from 1, as the report names it.
      const stoppedAt = unread.length > 0 ? { override: i + 1, missing: unread } : undefined
      return {
        verdict: base,
        overrideIndex: null,
        waitingOnCodeReview,
        ...(stoppedAt ? { stoppedAt } : {}),
      }
    }
    const merged: Verdict = {
      claude: ov.verdict?.claude ?? base.claude,
      seats: ov.verdict?.seats ?? base.seats,
      ...(ov.verdict?.maxAge === 'unset'
        ? {}
        : ov.verdict?.maxAge
          ? { maxAge: ov.verdict.maxAge }
          : base.maxAge
            ? { maxAge: base.maxAge }
            : {}),
    }
    return { verdict: merged, overrideIndex: i, waitingOnCodeReview: false }
  }
  return { verdict: base, overrideIndex: null, waitingOnCodeReview: false }
}

/** True when only a bot can fill the seat: every set it draws from names a bot, never a person. */
function isBotOnlySeat(seat: EvaluatedSeat): boolean {
  const included = seat.from.filter((item) => !item.startsWith('!'))
  return included.length > 0 && included.every((item) => item === 'bots' || item.startsWith('bot:'))
}

/**
 * The next step when the verdict approves and seats are unmet. The evaluator lists a seat once per
 * file and rule that asks for it, so identical seats count once, as the report prints them. A seat
 * only a bot can fill needs a final review of the head, not a person.
 */
export function unmetSeatsStep(unmetSeats: EvaluatedSeat[], depth: ReviewDepth | null): NextStep {
  const distinct = new Map<string, EvaluatedSeat>()
  for (const seat of unmetSeats) {
    distinct.set(JSON.stringify([seat.count, seat.from, seat.filledBy]), seat)
  }
  const reason = `${distinct.size} seat requirement(s) still unmet`
  if ([...distinct.values()].every(isBotOnlySeat)) {
    return {
      action: 'request_review',
      depth: depth ?? 'standard',
      reason: `${reason}, each fillable by a bot reviewer`,
    }
  }
  return { action: 'escalate', reason }
}
