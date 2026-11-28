import type { PullCheckResult } from '../policy/pull-check.js'
import type { EvaluationResult, PolicyFile, PolicyRule, SeatSet } from '../policy/types.js'

function formatSeats(seats: SeatSet[]): string {
  if (seats.length === 0) return '0'
  // The evaluator lists a seat once per file that asks for it; print each distinct seat once.
  return [...new Set(seats.map((s) => `${s.count} from [${s.from.join(', ')}]`))].join('; ')
}

export function formatRuleSummary(rule: PolicyRule): string {
  const verdict = rule.verdict
    ? `${rule.verdict.claude}, seats: ${formatSeats(rule.verdict.seats)}`
    : 'no verdict (advisory/findings/reuse)'
  const flags = [rule.mode, rule.nested === 'inherit' ? 'nested:inherit' : '']
    .filter(Boolean)
    .join(', ')
  return `- ${rule.purpose} [${flags}] (${rule.sourceFile})\n  paths: ${rule.paths.join(', ')}\n  verdict: ${verdict}\n  overrides: ${rule.override.length}`
}

export function formatPoliciesOverview(policies: PolicyFile[]): string {
  if (policies.length === 0) return 'No policy files found.\n'
  const lines: string[] = []
  for (const policy of policies) {
    lines.push(
      `${policy.path} (mode: ${policy.mode}, nested: ${policy.nested}, rules: ${policy.rules.length})`,
    )
    for (const rule of policy.rules) {
      lines.push(`  ${formatRuleSummary(rule).replace(/\n/g, '\n  ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function noResult(missing: string[]): string {
  const verb = missing.length === 1 ? 'has' : 'have'
  return `${missing.join(', ')} ${verb} no result (run supervisor-classify)`
}

function formatNextStep(result: EvaluationResult): string {
  if (result.nextStep.action === 'merge') return 'Next step: merge allowed'
  if (result.nextStep.action === 'request_review') {
    const why = result.nextStep.reason ? ` (${result.nextStep.reason})` : ''
    return `Next step: request review at depth ${result.nextStep.depth}${why}`
  }
  if (result.nextStep.action === 'shepherd') {
    return `Next step: run pr-shepherd on the pull request (${result.nextStep.reason})`
  }
  if (result.nextStep.action === 'collect_classifiers') {
    return `Next step: collect classifier results (${result.nextStep.missing.join(', ')}): run supervisor-classify, then check again`
  }
  return `Next step: escalate to a person (${result.nextStep.reason})`
}

function evaluationLines(result: EvaluationResult): string[] {
  const lines: string[] = []
  lines.push(`Verdict: ${result.verdict ?? 'none (uncovered)'}`)
  lines.push(`Review depth: ${result.reviewDepth ?? 'none'}`)
  lines.push(`Seats: ${formatSeats(result.seats)}`)
  if (result.uncoveredFiles.length > 0) {
    lines.push(`Uncovered files: ${result.uncoveredFiles.join(', ')}`)
  }
  for (const warning of result.authorOnlyWarnings) {
    lines.push(`Warning: ${warning}`)
  }
  for (const file of result.files) {
    const ruleNames = file.rules.map((r) => `${r.purpose} -> ${r.verdict.claude}`).join('; ')
    lines.push(`- ${file.file}: ${file.covered ? ruleNames || 'no rule applies' : 'uncovered'}`)
    for (const rule of file.rules) {
      if (rule.stoppedAt) {
        const { override, missing } = rule.stoppedAt
        lines.push(`  ${rule.purpose}: override ${override} not read: ${noResult(missing)}`)
      }
    }
    for (const rule of file.ifNotRead ?? []) {
      lines.push(`  ${rule.purpose}: rule condition not read: ${noResult(rule.missing)}`)
    }
  }
  return lines
}

export function formatHumanCheck(result: EvaluationResult): string {
  return `${[...evaluationLines(result), formatNextStep(result)].join('\n')}\n`
}

/** The same report for a pull request read from GitHub: its head, seats filled, and whether pr-shepherd would merge it. */
export function formatPullCheck(result: PullCheckResult): string {
  const { pull, readiness } = result
  const lines = [`Pull request: ${pull.repository}#${pull.number} at ${pull.head}`]
  lines.push(...evaluationLines(result))
  // Each file a rule applies to repeats the rule's seats; one line per distinct seat is enough.
  const seatLines = result.seats.map((seat) => {
    const filled = seat.filledBy.length > 0 ? seat.filledBy.join(', ') : 'nobody'
    return `Seat ${seat.count} from [${seat.from.join(', ')}]: filled by ${filled}`
  })
  lines.push(...new Set(seatLines))
  lines.push(
    `pr-shepherd: ${readiness.action} (${readiness.ready ? 'ready' : 'not ready'} to merge)`,
  )
  if (readiness.summary) lines.push(`pr-shepherd said: ${readiness.summary}`)
  for (const blocker of result.blockers) {
    lines.push(`Blocker: ${blocker}`)
  }
  lines.push(formatNextStep(result))
  return `${lines.join('\n')}\n`
}
