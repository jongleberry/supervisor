import { describe, expect, it } from 'vitest'
import type { ProcessResult, RunProcess } from '../src/state/process.js'
import { getFieldArg, okJson } from './helpers/pr.js'
import { makePullNode, REPO, runPrCli } from './helpers/pr-list.js'

function pageWithMoreComments(number: number, endCursor: string) {
  return okJson({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            makePullNode({
              number,
              title: 'Vanished',
              comments: ['ordinary'],
              hasNextComments: true,
              commentsEndCursor: endCursor,
            }),
          ],
        },
      },
    },
  })
}

describe('supervisor pr list errors', () => {
  it('exits 1 and reports gh and malformed GraphQL payloads cleanly', async () => {
    const errorPayloads: Array<[string, ProcessResult, string]> = [
      ['gh exit', { code: 1, stdout: '', stderr: 'HTTP 403 rate limit' }, 'HTTP 403 rate limit'],
      ['non-object json', { code: 0, stdout: 'null', stderr: '' }, 'unexpected response'],
      [
        'graphql error with message',
        okJson({ errors: [{ message: 'API limit exceeded' }] }),
        'API limit exceeded',
      ],
      [
        'graphql error without message',
        okJson({ errors: [{}] }),
        'GraphQL request returned errors',
      ],
      ['missing data', okJson({}), 'returned no data'],
      [
        'missing repository',
        okJson({ data: { repository: null } }),
        `Repository ${REPO} was not found`,
      ],
      [
        'bad pullRequests',
        okJson({ data: { repository: { pullRequests: null } } }),
        'unexpected pullRequests payload',
      ],
      [
        'bad pull node',
        okJson({
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 'x' }] },
            },
          },
        }),
        'unexpected pull request node',
      ],
      [
        'bad comments payload',
        okJson({
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [{ number: 1, title: 't', url: 'u', isDraft: false, comments: null }],
              },
            },
          },
        }),
        'unexpected comments',
      ],
      [
        'bad comment node',
        okJson({
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    number: 1,
                    title: 't',
                    url: 'u',
                    isDraft: false,
                    comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: 42 }] },
                  },
                ],
              },
            },
          },
        }),
        'unexpected comment node',
      ],
      [
        'bad pageInfo',
        okJson({ data: { repository: { pullRequests: { pageInfo: null, nodes: [] } } } }),
        'unexpected pullRequests pageInfo',
      ],
      [
        'missing endCursor on hasNextPage',
        okJson({
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: true, endCursor: '' }, nodes: [] },
            },
          },
        }),
        'invalid pullRequests endCursor',
      ],
    ]

    for (const [label, reply, expected] of errorPayloads) {
      const res = await runPrCli(['pr', 'list', REPO], async () => reply)
      expect(res.code, label).toBe(1)
      expect(res.stderr, label).toContain(expected)
    }
  })

  it('rejects non-advancing pagination cursors and missing PRs on comment pagination', async () => {
    const stalledRun: RunProcess = async () =>
      okJson({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'same' }, nodes: [] },
          },
        },
      })
    const stalledRes = await runPrCli(['pr', 'list', REPO], stalledRun)
    expect(stalledRes.code).toBe(1)
    expect(stalledRes.stderr).toContain('invalid pullRequests endCursor')

    const missingPull = await runPrCli(['pr', 'list', REPO], async (_cmd, args) =>
      getFieldArg(args, 'number')
        ? okJson({ data: { repository: { pullRequest: null } } })
        : pageWithMoreComments(7, 'c7'),
    )
    expect(missingPull.code).toBe(1)
    expect(missingPull.stderr).toContain(`Pull request ${REPO}#7 was not found`)

    const missingRepo = await runPrCli(['pr', 'list', REPO], async (_cmd, args) =>
      getFieldArg(args, 'number')
        ? okJson({ data: { repository: null } })
        : pageWithMoreComments(8, 'c8'),
    )
    expect(missingRepo.code).toBe(1)
    expect(missingRepo.stderr).toContain(`Pull request ${REPO}#8 was not found`)
  })
})
