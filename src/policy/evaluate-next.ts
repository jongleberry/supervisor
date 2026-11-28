import { unmetSeatsStep } from './evaluate-helpers.js'
import type { ClaudeAction, EvaluatedSeat, NextStep, ReviewDepth } from './types.js'

export interface NextStepInputs {
  anyHardBlock: boolean
  /** A hard block from something other than a missing classifier result. */
  otherHardBlock: boolean
  blockReasons: Set<string>
  anyWaitingOnCodeReview: boolean
  overallVerdict: ClaudeAction | null
  /** The strictest verdict among rules that no missing classifier result held back. */
  settledVerdict: ClaudeAction | null
  overallDepth: ReviewDepth | null
  unmetSeats: EvaluatedSeat[]
  uncoveredFiles: string[]
  /** The classifiers whose missing result stopped a rule's own `if` or an override. */
  missing: string[]
}

function policyStep(i: NextStepInputs): NextStep {
  if (i.anyHardBlock) return { action: 'escalate', reason: [...i.blockReasons].join('; ') }
  if (
    i.anyWaitingOnCodeReview &&
    (i.overallVerdict === 'blocks' || i.unmetSeats.length > 0 || i.overallVerdict === 'comments')
  ) {
    return { action: 'request_review', depth: i.overallDepth ?? 'standard' }
  }
  if (i.overallVerdict === 'blocks') {
    return { action: 'escalate', reason: 'A matching rule blocks merge' }
  }
  if (i.overallVerdict !== 'approves' || i.uncoveredFiles.length > 0) {
    // Only an `approves` verdict on every changed file lets the supervisor merge: `comments`, a
    // file no rule covers, and an empty change all go to a person, whatever the seats say.
    return {
      action: 'escalate',
      reason: 'Not every changed file has a rule that approves the merge',
    }
  }
  if (i.unmetSeats.length > 0) return unmetSeatsStep(i.unmetSeats, i.overallDepth)
  return { action: 'merge' }
}

/**
 * The policy's next step. When it would escalate and the only thing in the way is a classifier
 * result that is missing, collecting results is the step: the check still decides once they are in.
 */
export function computeNextStep(i: NextStepInputs): NextStep {
  const step = policyStep(i)
  const collectable =
    step.action === 'escalate' &&
    i.missing.length > 0 &&
    !i.otherHardBlock &&
    i.uncoveredFiles.length === 0 &&
    (i.settledVerdict === null || i.settledVerdict === 'approves')
  return collectable ? { action: 'collect_classifiers', missing: i.missing } : step
}
