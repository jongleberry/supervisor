import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ClassifierResult, EvaluationInput } from '../src/policy/types.js'
import { runCli } from '../src/cli/run.js'
import { classifyGh, policy, tempDir, writeTree } from './helpers/classify.js'
import { commit, fakeGh, file, fixture, HEAD, review } from './helpers/pull.js'

interface CorpusCase {
  id: string
  group: string
  label: 'merge' | 'person'
  input: EvaluationInput
}

const CORPUS_PATH = fileURLToPath(
  new URL('../evals/merge-classification/corpus/flake-fix.json', import.meta.url),
)
const REF_POLICY_PATH = fileURLToPath(
  new URL('../evals/merge-classification/policy/.claude/approvals.yml', import.meta.url),
)

const YES_NO_DEF = (description: string) => `version: 1
description: ${description}
model: haiku
prompt: Answer yes or no based on the diff.
outputs:
  answer:
    type: criteria
    values: ['yes', 'no']
`

function toGithubAccount(account: string) {
  return account.startsWith('bot:')
    ? { login: `${account.slice('bot:'.length)}[bot]`, type: 'Bot' }
    : { login: account, type: 'User' }
}

async function policyCheckFor(
  repository: string,
  dir: string,
  input: EvaluationInput,
  classifiersFile?: string,
) {
  const facts = input.facts ?? {}
  const opener = toGithubAccount(facts.openedBy ?? 'example-dev')
  const commits = (facts.authors ?? [facts.openedBy ?? 'example-dev']).map((author) =>
    commit(toGithubAccount(author), HEAD),
  )
  const reviews = (facts.approvedBy ?? []).map((approver) =>
    review(toGithubAccount(approver), 'APPROVED', HEAD),
  )
  const gh = fixture({
    files: input.changedFiles.map((filename) => file(filename)),
    commits,
    reviews,
    pull: {
      user: opener,
      labels: facts.labels ?? [],
    },
  })
  const run = fakeGh(gh).run
  const wrappedRun: typeof run = (cmd, args, opts) =>
    run(
      cmd,
      args.map((arg) => arg.replace(`repos/${repository}/`, 'repos/example-org/example-repo/')),
      opts,
    )
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(
    [
      'policy',
      'check',
      repository,
      '7',
      '--dir',
      dir,
      '--supervisor-policy',
      '--json',
      ...(classifiersFile ? ['--classifiers', classifiersFile] : []),
    ],
    {
      env: {},
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      startMcp: async () => undefined,
      runProcess: wrappedRun,
      shepherdStatus: async () => ({ action: 'merge', headSha: HEAD }),
      now: () => new Date(0),
    },
  )
  expect(err.join('')).toBe('')
  return { code, result: JSON.parse(out.join('')) }
}

describe('flake-fix corpus verification through the classifier runner', () => {
  it('gives every flake-fix corpus case the same outcome from the runner as by hand', async () => {
    const cases = JSON.parse(await readFile(CORPUS_PATH, 'utf8')) as CorpusCase[]
    expect(cases.length).toBeGreaterThan(0)

    const dir = await tempDir()
    await mkdir(join(dir, '.claude'), { recursive: true })
    await copyFile(REF_POLICY_PATH, join(dir, '.claude/approvals.yml'))
    await writeTree(dir, {
      '.claude/classifiers/flake_fix/def.yml': YES_NO_DEF('Is this change a flake fix?'),
      '.claude/classifiers/coverage_trade/def.yml': YES_NO_DEF(
        'Does this change trade coverage for green?',
      ),
    })

    for (const testCase of cases) {
      const repository = testCase.input.facts?.repository ?? 'example-org/app'
      const out = await tempDir()
      const prep = await policy(
        ['classify-prepare', repository, '7', '--dir', dir, '--supervisor-policy', '--out', out],
        classifyGh().run,
      )
      expect(prep.code, testCase.id).toBe(0)

      const given: Record<string, ClassifierResult> = testCase.input.classifiers ?? {}
      for (const [key, res] of Object.entries(given)) {
        if (!key.startsWith('repo/') || res.status !== 'complete' || res.value === undefined) {
          continue
        }
        const name = key.slice('repo/'.length)
        await writeFile(join(out, `${name}.answer.json`), JSON.stringify({ answer: res.value }))
      }

      const collected = await policy(['classify-collect', '--out', out], classifyGh().run)
      expect(collected.code, testCase.id).toBe(0)

      const runnerOutcome = await policyCheckFor(
        repository,
        dir,
        testCase.input,
        join(out, 'classifiers.json'),
      )

      let handFile: string | undefined
      if (testCase.input.classifiers) {
        handFile = join(out, 'by-hand.json')
        await writeFile(handFile, JSON.stringify(testCase.input.classifiers))
      }
      const handOutcome = await policyCheckFor(repository, dir, testCase.input, handFile)

      expect(runnerOutcome.code, testCase.id).toBe(handOutcome.code)
      expect(runnerOutcome.result.verdict, testCase.id).toBe(handOutcome.result.verdict)
      // A result the runner leaves out (an incomplete one) is missing, where by hand it was read:
      // the step is then to collect results, not to escalate.
      const step = (outcome: typeof handOutcome) =>
        outcome.result.nextStep.action === 'collect_classifiers'
          ? 'escalate'
          : outcome.result.nextStep.action
      expect(step(runnerOutcome), testCase.id).toBe(step(handOutcome))
      expect(runnerOutcome.result.nextStep.action === 'merge', testCase.id).toBe(
        testCase.label === 'merge',
      )
    }
  })
})
