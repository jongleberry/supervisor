import { describe, expect, it } from 'vitest'
import { hasProvenanceMarker, listProvenancePulls } from '../src/pr/list.js'
import { PROVENANCE_MARKER } from '../src/pr/provenance.js'
import type { RunProcess } from '../src/state/process.js'
import { getFieldArg, okJson } from './helpers/pr.js'
import { makePullNode, REPO, runPrCli } from './helpers/pr-list.js'

const unexpectedRun: RunProcess = async (cmd) => {
  throw new Error(`unexpected process: ${cmd}`)
}

describe('hasProvenanceMarker', () => {
  it('matches only when the first line is the exact provenance marker', () => {
    expect(hasProvenanceMarker(`${PROVENANCE_MARKER}\n- harness: claude-code`)).toBe(true)
    expect(hasProvenanceMarker(`${PROVENANCE_MARKER}\r\n- harness: claude-code`)).toBe(true)
    expect(hasProvenanceMarker(PROVENANCE_MARKER)).toBe(true)
    expect(hasProvenanceMarker('')).toBe(false)
    expect(hasProvenanceMarker('ordinary comment')).toBe(false)
    expect(hasProvenanceMarker(`Intro\n${PROVENANCE_MARKER}\n- harness: claude-code`)).toBe(false)
    expect(hasProvenanceMarker(`> ${PROVENANCE_MARKER}`)).toBe(false)
    expect(hasProvenanceMarker(` ${PROVENANCE_MARKER}\n- harness: claude-code`)).toBe(false)
    expect(hasProvenanceMarker(`${PROVENANCE_MARKER} extra\n- harness: claude-code`)).toBe(false)
  })
})

describe('supervisor pr list', () => {
  it('prints help for pr --help, pr list --help, and is listed in main --help', async () => {
    const mainHelp = await runPrCli(['--help'], unexpectedRun)
    expect(mainHelp.code).toBe(0)
    expect(mainHelp.stdout).toContain('pr list <owner>/<repo> [--json]')

    for (const args of [
      ['pr', '--help'],
      ['pr', '-h'],
      ['pr', 'list', '--help'],
      ['pr', 'list', '-h'],
    ]) {
      const res = await runPrCli(args, unexpectedRun)
      expect(res.code).toBe(0)
      expect(res.stdout).toMatch(/^Usage: supervisor pr list <owner>\/<repo> \[--json\]\n/)
      expect(res.stderr).toBe('')
    }
  })

  it('exits 2 on usage errors without invoking gh', async () => {
    for (const args of [
      ['pr'],
      ['pr', 'unknown'],
      ['pr', 'list'],
      ['pr', 'list', REPO, 'extra'],
      ['pr', 'list', 'not-a-repo'],
      ['pr', 'list', '../escape'],
      ['pr', 'list', REPO, '--bogus'],
    ]) {
      const res = await runPrCli(args, unexpectedRun)
      expect(res.code, args.join(' ')).toBe(2)
      expect(res.stderr).toContain('Usage: supervisor pr list')
    }
  })

  it('selects only open PRs carrying a provenance comment at the start of a comment body', async () => {
    const run: RunProcess = async (_cmd, args) => {
      expect(getFieldArg(args, 'owner')).toBe('example-org')
      expect(getFieldArg(args, 'repo')).toBe('example-repo')
      expect(getFieldArg(args, 'cursor')).toBeUndefined()
      return okJson({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                makePullNode({
                  number: 20,
                  title: 'Fix flaky\nmultiline title',
                  isDraft: true,
                  comments: ['LGTM', `${PROVENANCE_MARKER}\n- harness: claude-code`],
                }),
                makePullNode({ number: 15, title: 'Human PR', comments: [] }),
                makePullNode({
                  number: 18,
                  title: 'Quoted marker',
                  comments: [`See below:\n${PROVENANCE_MARKER}`, `> ${PROVENANCE_MARKER}`],
                }),
                makePullNode({
                  number: 12,
                  title: 'Update docs',
                  comments: [`${PROVENANCE_MARKER}\r\n- harness: claude-code`],
                }),
              ],
            },
          },
        },
      })
    }

    const jsonRes = await runPrCli(['pr', 'list', REPO, '--json'], run)
    expect(jsonRes.code).toBe(0)
    expect(jsonRes.stderr).toBe('')
    expect(JSON.parse(jsonRes.stdout)).toEqual([
      {
        repository: REPO,
        number: 12,
        title: 'Update docs',
        url: `https://github.com/${REPO}/pull/12`,
        isDraft: false,
      },
      {
        repository: REPO,
        number: 20,
        title: 'Fix flaky\nmultiline title',
        url: `https://github.com/${REPO}/pull/20`,
        isDraft: true,
      },
    ])

    const textRes = await runPrCli(['pr', 'list', REPO], run)
    expect(textRes.code).toBe(0)
    expect(textRes.stdout).toBe(
      `${REPO}#12  Update docs\n${REPO}#20  [draft] Fix flaky multiline title\n`,
    )
  })

  it('paginates pull requests and comments, stopping comment pagination once matched', async () => {
    const calls: string[] = []
    const run: RunProcess = async (_cmd, args) => {
      const query = getFieldArg(args, 'query') ?? ''
      const cursor = getFieldArg(args, 'cursor')
      const number = getFieldArg(args, 'number')
      calls.push(number ? `comments:${number}:${cursor}` : `pulls:${cursor ?? 'first'}`)

      if (query.includes('pullRequests(')) {
        const nodes =
          cursor === undefined
            ? [
                makePullNode({
                  number: 30,
                  title: 'Matched page 1',
                  comments: [`${PROVENANCE_MARKER}\n- harness: claude-code`],
                  hasNextComments: true,
                  commentsEndCursor: 'unused',
                }),
                makePullNode({
                  number: 10,
                  title: 'Matched comment page 3',
                  comments: ['c1'],
                  hasNextComments: true,
                  commentsEndCursor: 'c-10-p2',
                }),
              ]
            : [
                makePullNode({
                  number: 25,
                  title: 'No provenance',
                  comments: ['c1'],
                  hasNextComments: true,
                  commentsEndCursor: 'c-25-p2',
                }),
              ]
        const pageInfo =
          cursor === undefined
            ? { hasNextPage: true, endCursor: 'pr-page-2' }
            : { hasNextPage: false, endCursor: null }
        return okJson({ data: { repository: { pullRequests: { pageInfo, nodes } } } })
      }
      const comments =
        number === '10' && cursor === 'c-10-p2'
          ? { pageInfo: { hasNextPage: true, endCursor: 'c-10-p3' }, nodes: [{ body: 'other' }] }
          : number === '10' && cursor === 'c-10-p3'
            ? {
                pageInfo: { hasNextPage: true, endCursor: 'c-10-p4' },
                nodes: [{ body: `${PROVENANCE_MARKER}\n- harness: claude-code` }],
              }
            : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ body: 'ordinary' }] }
      return okJson({ data: { repository: { pullRequest: { comments } } } })
    }

    const pulls = await listProvenancePulls(run, REPO)
    expect(pulls.map((p) => p.number)).toEqual([10, 30])
    expect(calls).toEqual([
      'pulls:first',
      'comments:10:c-10-p2',
      'comments:10:c-10-p3',
      'pulls:pr-page-2',
      'comments:25:c-25-p2',
    ])
  })

  it('returns an empty list cleanly when no open PRs match', async () => {
    const run: RunProcess = async () =>
      okJson({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      })
    expect((await runPrCli(['pr', 'list', REPO, '--json'], run)).stdout).toBe('[]\n')
    expect((await runPrCli(['pr', 'list', REPO], run)).stdout).toBe('')
  })
})
