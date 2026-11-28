import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPolicies } from '../src/policy/discover.js'
import { evaluatePolicies } from '../src/policy/evaluate.js'
import { parsePolicySource } from '../src/policy/load.js'
import { PolicyLoadError } from '../src/policy/types.js'

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/policies/${name}`, import.meta.url))

describe('policy evaluation against fixtures', () => {
  it('docs-light: requests quick review when absent, merges on pass, escalates on error', async () => {
    const policies = await discoverPolicies(fixture('docs-light'))

    const pending = evaluatePolicies(policies, {
      changedFiles: ['docs/guide.md'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
    })
    expect(pending.verdict).toBe('comments')
    expect(pending.reviewDepth).toBe('quick')
    expect(pending.nextStep).toEqual({ action: 'request_review', depth: 'quick' })

    const passed = evaluatePolicies(policies, {
      changedFiles: ['docs/guide.md'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
      classifiers: { 'claude/code_review': { status: 'complete', value: 'pass', level: 'quick' } },
    })
    expect(passed.verdict).toBe('approves')
    expect(passed.seats).toEqual([])
    expect(passed.nextStep).toEqual({ action: 'merge' })

    const errored = evaluatePolicies(policies, {
      changedFiles: ['docs/guide.md'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
      classifiers: { 'claude/code_review': { status: 'error' } },
    })
    expect(errored.verdict).toBe('comments')
    expect(errored.seats[0]!.remaining).toBe(1)
  })

  it('sensitive-deep: requires deep review and security team seat, catches error override', async () => {
    const policies = await discoverPolicies(fixture('sensitive-deep'))

    const shallow = evaluatePolicies(policies, {
      changedFiles: ['src/auth/login.ts'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
      classifiers: {
        'claude/code_review': {
          status: 'complete',
          value: 'pass',
          level: 'quick',
          severity: 'none',
        },
      },
    })
    expect(shallow.verdict).toBe('blocks')
    expect(shallow.reviewDepth).toBe('deep')
    expect(shallow.nextStep).toEqual({ action: 'request_review', depth: 'deep' })

    const needsSeat = evaluatePolicies(policies, {
      changedFiles: ['src/auth/login.ts'],
      facts: {
        openedBy: 'dev-one',
        authors: ['dev-one'],
        teams: { 'example-org/security': ['sec-lead'] },
      },
      classifiers: {
        'claude/code_review': { status: 'complete', value: 'pass', level: 'deep', severity: 'low' },
      },
    })
    expect(needsSeat.verdict).toBe('comments')
    expect(needsSeat.seats[0]!.remaining).toBe(1)
    expect(needsSeat.nextStep.action).toBe('escalate')

    const approved = evaluatePolicies(policies, {
      changedFiles: ['src/auth/login.ts'],
      facts: {
        openedBy: 'dev-one',
        authors: ['dev-one'],
        approvedBy: ['sec-lead'],
        teams: { 'example-org/security': ['sec-lead'] },
      },
      classifiers: {
        'claude/code_review': {
          status: 'complete',
          value: 'pass',
          level: 'deep',
          severity: 'none',
        },
      },
    })
    expect(approved.verdict).toBe('comments')
    expect(approved.seats[0]!.remaining).toBe(0)
    expect(approved.nextStep).toEqual({
      action: 'escalate',
      reason: 'Not every changed file has a rule that approves the merge',
    })

    const errored = evaluatePolicies(policies, {
      changedFiles: ['src/auth/login.ts'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
      classifiers: { 'claude/code_review': { status: 'error' } },
    })
    expect(errored.verdict).toBe('comments')
    expect(errored.seats[0]!.count).toBe(2)
    expect(errored.nextStep.action).toBe('escalate')
  })

  it('nested-inherit: carries root always-human rule into services/payments with deep review', async () => {
    const policies = await discoverPolicies(fixture('nested-inherit'))
    const result = evaluatePolicies(policies, {
      changedFiles: ['services/payments/src/charge.ts'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
      classifiers: { 'claude/code_review': { status: 'complete', value: 'pass', level: 'deep' } },
    })
    expect(result.reviewDepth).toBe('deep')
    expect(result.verdict).toBe('comments')
    expect(result.seats).toHaveLength(1)
    expect(result.seats[0]!.remaining).toBe(1)
    expect(result.nextStep.action).toBe('escalate')
  })

  it('unknown-key: refuses the policy file with exact key path', async () => {
    await expect(discoverPolicies(fixture('unknown-key'))).rejects.toThrow(PolicyLoadError)
    try {
      await discoverPolicies(fixture('unknown-key'))
    } catch (err) {
      expect((err as PolicyLoadError).errors[0]!.path).toBe('rules[0].bogus_key')
    }
  })

  it('author-only: flags rules whose seats can be met by the author alone', async () => {
    const policies = await discoverPolicies(fixture('author-only'))
    const result = evaluatePolicies(policies, {
      changedFiles: ['src/index.ts'],
      facts: { openedBy: 'dev-one', authors: ['dev-one'] },
    })
    expect(result.verdict).toBe('approves')
    expect(result.seats[0]!.remaining).toBe(0)
    expect(result.seats[0]!.authorOnly).toBe(true)
    expect(result.authorOnlyWarnings).toHaveLength(1)
    expect(result.nextStep).toEqual({ action: 'merge' })
  })

  it('handles uncovered files, all-if-false, unresolved own if, and blocks verdict', () => {
    const policy = parsePolicySource(`
version: 1
rules:
  - purpose: Large PR only
    paths: ['src/**']
    if: 'pr/files_changed > 10'
    verdict: { claude: approves, seats: 0 }
  - purpose: Classifier in rule if
    paths: ['lib/**']
    if: 'repo/gate = pass'
    verdict: { claude: approves, seats: 0 }
  - purpose: Always blocked
    paths: ['frozen/**']
    verdict: { claude: blocks }
`)
    const uncovered = evaluatePolicies([policy], { changedFiles: ['README.md'] })
    expect(uncovered.uncoveredFiles).toEqual(['README.md'])
    expect(uncovered.nextStep).toEqual({
      action: 'escalate',
      reason: 'Not every changed file has a rule that approves the merge',
    })
    expect(evaluatePolicies([policy], { changedFiles: [] }).nextStep).toEqual({
      action: 'escalate',
      reason: 'Not every changed file has a rule that approves the merge',
    })

    const noneApplied = evaluatePolicies([policy], { changedFiles: ['src/a.ts'] })
    expect(noneApplied.files[0]!.noRuleApplies).toBe(true)
    expect(noneApplied.nextStep.action).toBe('escalate')

    const unresolved = evaluatePolicies([policy], { changedFiles: ['lib/a.ts'] })
    expect(unresolved.files[0]!.unresolvedRuleIf).toBe(true)
    expect(unresolved.nextStep).toEqual({ action: 'collect_classifiers', missing: ['repo/gate'] })

    const blocked = evaluatePolicies([policy], { changedFiles: ['frozen/a.ts'] })
    expect(blocked.verdict).toBe('blocks')
    expect(blocked.nextStep.action).toBe('escalate')
  })
})
