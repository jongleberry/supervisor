import { evaluateCondition } from './conditions.js'
import { computeNextStep } from './evaluate-next.js'
import { missingClassifiers } from './missing-classifiers.js'
import { selectRulesForFile } from './discover.js'
import {
  evaluateRuleVerdict,
  evaluateSeat,
  maxDepth,
  ruleReviewDepth,
  strictestClaude,
} from './evaluate-helpers.js'
import { matchesRulePaths, toRelativePath } from './glob.js'
import { PROTECTED_BASELINE, isProtectedPath } from './protected.js'
import type {
  AppliedRuleResult,
  ClaudeAction,
  EvaluatedSeat,
  EvaluationFacts,
  EvaluationInput,
  EvaluationResult,
  FileEvaluation,
  PolicyFile,
  ReviewDepth,
  UnreadRule,
} from './types.js'

export function evaluatePolicies(policies: PolicyFile[], input: EvaluationInput): EvaluationResult {
  const facts: EvaluationFacts = { filesChanged: input.changedFiles.length, ...input.facts }
  const classifiers = input.classifiers ?? {}
  const files: FileEvaluation[] = []
  const uncoveredFiles: string[] = []
  const allSeats: EvaluatedSeat[] = []
  const authorOnlyWarnings: string[] = []
  let overallVerdict: ClaudeAction | null = null
  let overallDepth: ReviewDepth | null = null
  let anyWaitingOnCodeReview = false
  let anyHardBlock = false
  let otherHardBlock = false
  let settledVerdict: ClaudeAction | null = null
  const missing = new Set<string>()
  const blockReasons = new Set<string>()

  // A changed protected file that no rule applies to takes the baseline instead: one person, no
  // bot, and never a merge by the supervisor, whatever the other files' rules say.
  const protectedBaseline = (file: string): EvaluatedSeat[] | null => {
    if (!isProtectedPath(file)) return null
    const seats = PROTECTED_BASELINE.seats.map((s) => evaluateSeat(s, facts))
    allSeats.push(...seats)
    overallVerdict = strictestClaude(overallVerdict, PROTECTED_BASELINE.claude)
    anyHardBlock = true
    otherHardBlock = true
    blockReasons.add(
      `No rule applies to protected file '${file}': a person must approve it, and the supervisor never merges it`,
    )
    return seats
  }

  for (const file of input.changedFiles) {
    const { decidingPolicy, rules } = selectRulesForFile(policies, file)
    const verdictRules = rules.filter((r) => r.verdict !== undefined)
    if (!decidingPolicy || verdictRules.length === 0) {
      uncoveredFiles.push(file)
      const baseline = protectedBaseline(file)
      files.push({
        file,
        decidingPolicy: decidingPolicy?.path ?? null,
        covered: false,
        protectedBaseline: baseline !== null,
        noRuleApplies: false,
        unresolvedRuleIf: false,
        rules: [],
        verdict: baseline ? PROTECTED_BASELINE.claude : null,
        seats: baseline ?? [],
        reviewDepth: null,
      })
      continue
    }

    let fileDepth: ReviewDepth | null = null
    for (const rule of rules) fileDepth = maxDepth(fileDepth, ruleReviewDepth(rule))
    overallDepth = maxDepth(overallDepth, fileDepth)

    const applied: AppliedRuleResult[] = []
    let fileVerdict: ClaudeAction | null = null
    const fileSeats: EvaluatedSeat[] = []
    let unresolvedRuleIf = false
    const ifNotRead: UnreadRule[] = []

    for (const rule of verdictRules) {
      const ruleCount = input.changedFiles.filter((f) => {
        const rel = toRelativePath(f, rule.baseDir)
        return rel !== null && matchesRulePaths(rel, rule.paths)
      }).length
      const ctx = {
        facts,
        ruleFacts: { filesChanged: ruleCount, filesAdded: ruleCount, filesRemoved: 0 },
        classifiers,
      }
      const ifRes = evaluateCondition(rule.if, ctx)
      if (ifRes === 'false') continue
      if (ifRes === 'unknown') {
        unresolvedRuleIf = true
        anyHardBlock = true
        const unread = missingClassifiers(rule.if, classifiers)
        if (unread.length > 0) {
          ifNotRead.push({ purpose: rule.purpose, sourceFile: rule.sourceFile, missing: unread })
          for (const name of unread) missing.add(name)
        } else {
          otherHardBlock = true
        }
        blockReasons.add(`Rule '${rule.purpose}' condition could not be evaluated`)
        continue
      }
      const { verdict, overrideIndex, waitingOnCodeReview, stoppedAt } = evaluateRuleVerdict(
        rule,
        facts,
        ruleCount,
        classifiers,
      )
      if (waitingOnCodeReview) anyWaitingOnCodeReview = true
      fileVerdict = strictestClaude(fileVerdict, verdict.claude)
      if (stoppedAt) for (const name of stoppedAt.missing) missing.add(name)
      else settledVerdict = strictestClaude(settledVerdict, verdict.claude)
      const evaluatedSeats = verdict.seats.map((s) => evaluateSeat(s, facts))
      const authorOnlySeats = evaluatedSeats.some((s) => s.authorOnly)
      if (authorOnlySeats) {
        const warning = `Rule '${rule.purpose}' (${rule.sourceFile}) has seats that can be met by the author alone`
        if (!authorOnlyWarnings.includes(warning)) authorOnlyWarnings.push(warning)
      }
      fileSeats.push(...evaluatedSeats)
      allSeats.push(...evaluatedSeats)
      applied.push({
        purpose: rule.purpose,
        sourceFile: rule.sourceFile,
        verdict,
        overrideIndex,
        waitingOnClassifier: waitingOnCodeReview,
        authorOnlySeats,
        ...(stoppedAt ? { stoppedAt } : {}),
      })
    }

    const noRuleApplies = applied.length === 0 && !unresolvedRuleIf
    const baseline = noRuleApplies ? protectedBaseline(file) : null
    if (baseline) {
      fileVerdict = PROTECTED_BASELINE.claude
      fileSeats.push(...baseline)
    } else if (noRuleApplies) {
      anyHardBlock = true
      otherHardBlock = true
      blockReasons.add(`No rule applies to '${file}'`)
    }
    if (fileVerdict) overallVerdict = strictestClaude(overallVerdict, fileVerdict)
    files.push({
      file,
      decidingPolicy: decidingPolicy.path,
      covered: true,
      protectedBaseline: baseline !== null,
      noRuleApplies,
      unresolvedRuleIf,
      ...(ifNotRead.length > 0 ? { ifNotRead } : {}),
      rules: applied,
      verdict: fileVerdict,
      seats: fileSeats,
      reviewDepth: fileDepth,
    })
  }

  const unmetSeats = allSeats.filter((s) => s.remaining > 0)
  const nextStep = computeNextStep({
    anyHardBlock,
    otherHardBlock,
    blockReasons,
    anyWaitingOnCodeReview,
    overallVerdict,
    settledVerdict,
    overallDepth,
    unmetSeats,
    uncoveredFiles,
    missing: [...missing],
  })

  return {
    files,
    uncoveredFiles,
    verdict: overallVerdict,
    seats: allSeats,
    reviewDepth: overallDepth,
    authorOnlyWarnings,
    nextStep,
  }
}
