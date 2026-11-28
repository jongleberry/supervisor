import { describe, expect, it } from 'vitest'
import type { ClassifierResult } from '../src/policy/types.js'
import { formatHumanCheck } from '../src/cli/policy-format.js'
import { evaluatePolicies } from '../src/policy/evaluate.js'
import { parsePolicySource } from '../src/policy/load.js'

const FACTS = { openedBy: 'dev-one', authors: ['dev-one'] }

const POLICY = parsePolicySource(`
version: 1
rules:
  - purpose: Test only
    paths: ['test/**']
    verdict: { claude: comments, seats: 0 }
    override:
      - if: 'ALL pr/authors = dev-one AND repo/trade_off = no'
        verdict: { claude: approves, seats: 0 }
  - purpose: After a false override
    paths: ['lib/**']
    verdict: { claude: comments, seats: 0 }
    override:
      - if: 'pr/files_changed > 10'
        verdict: { claude: approves, seats: 0 }
      - if: 'repo/trade_off = no AND repo/other = ok'
        verdict: { claude: approves, seats: 0 }
  - purpose: Gated rule
    paths: ['gated/**']
    if: 'repo/gate = pass'
    verdict: { claude: approves, seats: 0 }
  - purpose: Blocked
    paths: ['frozen/**']
    verdict: { claude: blocks }
`)

const run = (changedFiles: string[], classifiers = {}) =>
  evaluatePolicies([POLICY], { changedFiles, facts: FACTS, classifiers })

describe('a missing classifier result that stops reading overrides', () => {
  it('names the first override and the classifier, and keeps the rule verdict', () => {
    const result = run(['test/a.ts'])
    const rule = result.files[0]!.rules[0]!
    expect(rule.stoppedAt).toEqual({ override: 1, missing: ['repo/trade_off'] })
    expect(rule.verdict.claude).toBe('comments')
    expect(result.nextStep).toEqual({ action: 'collect_classifiers', missing: ['repo/trade_off'] })
    expect(formatHumanCheck(result)).toContain(
      '  Test only: override 1 not read: repo/trade_off has no result (run supervisor-classify)',
    )
    expect(formatHumanCheck(result)).toContain(
      'Next step: collect classifier results (repo/trade_off)',
    )
  })

  it('counts the override after a false one, and lists each missing classifier', () => {
    const result = run(['lib/a.ts'])
    expect(result.files[0]!.rules[0]!.stoppedAt).toEqual({
      override: 2,
      missing: ['repo/trade_off', 'repo/other'],
    })
    expect(formatHumanCheck(result)).toContain(
      'override 2 not read: repo/trade_off, repo/other have no result',
    )
  })

  it('names a rule whose own if could not be read', () => {
    const result = run(['gated/a.ts'])
    expect(result.files[0]!.ifNotRead).toEqual([
      { purpose: 'Gated rule', sourceFile: expect.any(String), missing: ['repo/gate'] },
    ])
    expect(formatHumanCheck(result)).toContain(
      '  Gated rule: rule condition not read: repo/gate has no result (run supervisor-classify)',
    )
    expect(result.nextStep).toEqual({ action: 'collect_classifiers', missing: ['repo/gate'] })
  })

  it('says nothing when the result is there, and decides on it', () => {
    const result = run(['test/a.ts'], { 'repo/trade_off': { status: 'complete', value: 'no' } })
    expect(result.files[0]!.rules[0]!.stoppedAt).toBeUndefined()
    expect(result.nextStep).toEqual({ action: 'merge' })
    expect(JSON.parse(JSON.stringify(result)).files[0].rules[0]).not.toHaveProperty('stoppedAt')
  })

  it('serializes stoppedAt in the JSON result', () => {
    const json = JSON.parse(JSON.stringify(run(['test/a.ts'])))
    expect(json.files[0].rules[0].stoppedAt).toEqual({ override: 1, missing: ['repo/trade_off'] })
  })

  it('still escalates when something else keeps the verdict from approving', () => {
    expect(run(['test/a.ts', 'frozen/a.ts']).nextStep.action).toBe('escalate')
    expect(run(['test/a.ts', 'README.md']).nextStep.action).toBe('escalate')
  })

  it('does not name a classifier for a condition undecided for another reason', () => {
    const policy = parsePolicySource(`
version: 1
rules:
  - purpose: Needs authors
    paths: ['src/**']
    if: 'ANY pr/authors = dev-one'
    verdict: { claude: approves, seats: 0 }
`)
    const result = evaluatePolicies([policy], { changedFiles: ['src/a.ts'] })
    expect(result.files[0]!.ifNotRead).toBeUndefined()
    expect(result.nextStep.action).toBe('escalate')
  })

  it('names a versioned classifier as the condition spells it', () => {
    const policy = parsePolicySource(`
version: 1
rules:
  - purpose: Versioned
    paths: ['src/**']
    verdict: { claude: comments, seats: 0 }
    override:
      - if: 'repo/trade_off@2 = no'
        verdict: { claude: approves, seats: 0 }
`)
    const input = { changedFiles: ['src/a.ts'], facts: FACTS }
    const stopped = (classifiers: Record<string, ClassifierResult>) =>
      evaluatePolicies([policy], { ...input, classifiers }).files[0]!.rules[0]!.stoppedAt
    expect(stopped({})).toEqual({ override: 1, missing: ['repo/trade_off@2'] })
    expect(stopped({ 'repo/trade_off@2': { status: 'complete', value: 'no' } })).toBeUndefined()
    expect(stopped({ 'repo/trade_off': { status: 'complete', value: 'yes' } })).toBeUndefined()
  })
})
