import { afterEach, describe, expect, it } from 'vitest'
import { cleanupLoops, done, makeLoop } from './helpers/loop.js'
import { fake, GOOD } from './helpers/preflight.js'

const REPORT_SCOPES = [
  { owner: 'example-org', kind: 'org', repos: '*', mode: 'report' },
  { owner: 'example-user', kind: 'user', repos: ['demo-repo'], mode: 'report' },
]

describe('supervisor preflight labels check', () => {
  afterEach(cleanupLoops)

  it('skips checking labels with no gh api calls when all scopes are in report mode', async () => {
    const loop = await makeLoop({ scopes: REPORT_SCOPES })
    const { run, seen } = fake(GOOD)
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: skipped: no scopes in enforce mode\n')
    expect(seen).toEqual(['supervisor --version', 'gh auth status', 'pr-shepherd --version'])
  })

  it('skips as ok with no gh api calls when labels.needsHuman is omitted (even with deprecated labels.automation)', async () => {
    const omitted = await makeLoop({ labels: undefined })
    const { run, seen } = fake(GOOD)
    const result = await omitted.cli(['preflight'], run)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: skipped: labels not configured\n')
    expect(seen).toEqual(['supervisor --version', 'gh auth status', 'pr-shepherd --version'])

    const empty = await makeLoop({ labels: {} })
    const emptyResult = await empty.cli(['preflight'], fake(GOOD).run)
    expect(emptyResult.code).toBe(0)
    expect(emptyResult.stdout).toContain('ok   labels: skipped: labels not configured\n')

    const onlyAutomation = await makeLoop({ labels: { automation: 'automation' } })
    const autoCalls = fake(GOOD)
    const autoResult = await onlyAutomation.cli(['preflight'], autoCalls.run)
    expect(autoResult.code).toBe(0)
    expect(autoResult.stdout).toContain('ok   labels: skipped: labels not configured\n')
    expect(autoCalls.seen).toEqual([
      'supervisor --version',
      'gh auth status',
      'pr-shepherd --version',
    ])
  })

  it('ignores deprecated labels.automation and checks only labels.needsHuman', async () => {
    const both = await makeLoop({
      labels: { automation: 'automation', needsHuman: 'needs-human' },
    })
    let graphqlArgs: string[] = []
    const result = await both.cli(
      ['preflight'],
      fake({
        ...GOOD,
        ghGraphql: (args) => {
          graphqlArgs = args
          return done(JSON.stringify({ data: { r0: { needsHuman: { name: 'needs-human' } } } }))
        },
      }).run,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: 1 repo checked (needs-human)\n')
    expect(graphqlArgs.join(' ')).not.toContain('automation')

    const missing = await both.cli(
      ['preflight'],
      fake({
        ...GOOD,
        ghGraphql: done(JSON.stringify({ data: { r0: { needsHuman: null } } })),
      }).run,
    )
    expect(missing.code).toBe(0)
    expect(missing.stdout).toContain(
      'ok   labels: missing: example-org/example-repo (needs-human)\n',
    )
  })

  it('checks a report-mode scope as enforce with --enforce-scope and reports missing labels as ok', async () => {
    const loop = await makeLoop({ scopes: REPORT_SCOPES })
    const { run, seen } = fake({
      ...GOOD,
      ghUser: done('example-user\n'),
      ghRepos: done('demo-repo\tfalse\nother-repo\tfalse\n'),
      ghGraphql: done(
        JSON.stringify({
          data: {
            r0: { needsHuman: null },
          },
        }),
      ),
    })
    const result = await loop.cli(['preflight', '--enforce-scope', 'Example-User', '--json'], run)
    expect(result.code).toBe(0)
    const labels = JSON.parse(result.stdout).checks.find(
      (check: { name: string }) => check.name === 'labels',
    )
    expect(labels).toEqual({
      name: 'labels',
      ok: true,
      detail: 'missing: example-user/demo-repo (needs-human)',
    })
    expect(seen.some((cmd) => cmd.includes('gh api user --jq .login'))).toBe(true)
    expect(seen.some((cmd) => cmd.includes('user/repos?affiliation=owner&per_page=100'))).toBe(true)
  })

  it('reuses signed-in login across user scopes and groups multiple scopes per owner', async () => {
    const loop = await makeLoop({
      scopes: [
        { owner: 'example-user', kind: 'user', repos: ['repo-a'], mode: 'enforce' },
        { owner: 'example-user', kind: 'user', repos: ['repo-b'], mode: 'enforce' },
        { owner: 'other-user', kind: 'user', repos: ['repo-c'], mode: 'enforce' },
      ],
    })
    let userCalls = 0
    const { run, seen } = fake({
      ...GOOD,
      ghUser: () => {
        userCalls += 1
        return done('example-user\n')
      },
      ghRepos: (args) =>
        args[2]!.startsWith('user/repos')
          ? done('repo-a\tfalse\nrepo-b\tfalse\n')
          : done('repo-c\tfalse\n'),
      ghGraphql: done(
        JSON.stringify({
          data: {
            r0: { needsHuman: { name: 'needs-human' } },
            r1: { needsHuman: { name: 'needs-human' } },
            r2: { needsHuman: { name: 'needs-human' } },
          },
        }),
      ),
    })
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: 3 repos checked (needs-human)\n')
    expect(userCalls).toBe(1)
    expect(seen.some((cmd) => cmd.includes('users/other-user/repos?per_page=100'))).toBe(true)
  })

  it('reports ok when enforced scopes select no repositories', async () => {
    const loop = await makeLoop()
    const result = await loop.cli(['preflight'], fake({ ...GOOD, ghRepos: done('') }).run)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: no repositories matched\n')
  })

  it('reports missing labels across repositories without exiting 1', async () => {
    const loop = await makeLoop()
    const result = await loop.cli(
      ['preflight'],
      fake({
        ...GOOD,
        ghRepos: done('repo-a\tfalse\nrepo-b\tfalse\n'),
        ghGraphql: done(
          JSON.stringify({
            data: {
              r0: { needsHuman: null },
              r1: { needsHuman: { name: 'needs-human' } },
            },
          }),
        ),
      }).run,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   labels: missing: example-org/repo-a (needs-human)\n')
  })

  it('batches GraphQL label checks across more than 25 repositories', async () => {
    const loop = await makeLoop()
    const repoLines = Array.from(
      { length: 27 },
      (_, i) => `repo-${String(i).padStart(2, '0')}\tfalse`,
    )
    let graphqlCalls = 0
    const { run } = fake({
      ...GOOD,
      ghRepos: done(`${repoLines.join('\n')}\n`),
      ghGraphql: (args) => {
        graphqlCalls += 1
        const query = args.find((arg) => arg.startsWith('query='))!
        const matches = [...query.matchAll(/\br(\d+):repository/g)]
        const data: Record<string, unknown> = {}
        for (const match of matches) {
          data[`r${match[1]}`] = {
            needsHuman: { name: 'needs-human' },
          }
        }
        return done(JSON.stringify({ data, errors: [] }))
      },
    })
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(0)
    expect(graphqlCalls).toBe(2)
    expect(result.stdout).toContain('ok   labels: 27 repos checked (needs-human)\n')
  })
})
