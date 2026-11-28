import { isObject, type JsonObject } from '../state/json.js'
import type { RunProcess } from '../state/process.js'
import { ghJson, PrToolError } from './gh-client.js'
import { PROVENANCE_MARKER } from './provenance.js'

const OPEN_PULLS_QUERY = [
  'query($owner: String!, $repo: String!, $cursor: String) {',
  '  repository(owner: $owner, name: $repo) {',
  '    pullRequests(states: [OPEN], first: 50, after: $cursor) {',
  '      pageInfo { hasNextPage endCursor }',
  '      nodes {',
  '        number title url isDraft',
  '        comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { body } }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n')

const PULL_COMMENTS_QUERY = [
  'query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {',
  '  repository(owner: $owner, name: $repo) {',
  '    pullRequest(number: $number) {',
  '      comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { body } }',
  '    }',
  '  }',
  '}',
].join('\n')

export interface ProvenancePull {
  repository: string
  number: number
  title: string
  url: string
  isDraft: boolean
}

/** True when a comment body's first line is the exact supervisor provenance marker. */
export function hasProvenanceMarker(body: string): boolean {
  const newline = body.indexOf('\n')
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).replace(/\r$/, '')
  return firstLine === PROVENANCE_MARKER
}

function badResponse(message: string): never {
  throw new PrToolError('gh-invalid-response', `gh api graphql ${message}`)
}

async function runGraphql(
  run: RunProcess,
  query: string,
  owner: string,
  repo: string,
  extra: string[],
): Promise<JsonObject> {
  const raw = await ghJson(
    run,
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      ...extra,
    ],
    'api graphql',
  )
  if (!isObject(raw)) badResponse('returned an unexpected response')
  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    const first = raw.errors[0]
    const message =
      isObject(first) && typeof first.message === 'string' && first.message.trim() !== ''
        ? first.message
        : 'GraphQL request returned errors'
    throw new PrToolError('gh-failed', message)
  }
  if (!isObject(raw.data)) badResponse('returned no data')
  return raw.data
}

function parsePageInfo(raw: unknown, label: string, prev: string | undefined): string | undefined {
  if (!isObject(raw) || typeof raw.hasNextPage !== 'boolean') {
    badResponse(`returned unexpected ${label} pageInfo`)
  }
  if (!raw.hasNextPage) return undefined
  if (typeof raw.endCursor !== 'string' || raw.endCursor === '' || raw.endCursor === prev) {
    badResponse(`returned invalid ${label} endCursor`)
  }
  return raw.endCursor
}

function parseCommentsPage(
  raw: unknown,
  prev: string | undefined,
): { matched: boolean; nextCursor: string | undefined } {
  if (!isObject(raw) || !Array.isArray(raw.nodes)) badResponse('returned unexpected comments')
  let matched = false
  for (const node of raw.nodes) {
    if (!isObject(node) || typeof node.body !== 'string') {
      badResponse('returned unexpected comment node')
    }
    if (hasProvenanceMarker(node.body)) matched = true
  }
  if (matched) return { matched: true, nextCursor: undefined }
  return { matched: false, nextCursor: parsePageInfo(raw.pageInfo, 'comments', prev) }
}

async function hasProvenanceInRemainingComments(
  run: RunProcess,
  owner: string,
  repo: string,
  repository: string,
  number: number,
  firstCursor: string,
): Promise<boolean> {
  let cursor: string | undefined = firstCursor
  while (cursor !== undefined) {
    const data = await runGraphql(run, PULL_COMMENTS_QUERY, owner, repo, [
      '-F',
      `number=${number}`,
      '-f',
      `cursor=${cursor}`,
    ])
    const repoObj = isObject(data.repository) ? data.repository : undefined
    const pullObj = repoObj && isObject(repoObj.pullRequest) ? repoObj.pullRequest : undefined
    if (pullObj === undefined) {
      throw new PrToolError('not-found', `Pull request ${repository}#${number} was not found.`)
    }
    const page = parseCommentsPage(pullObj.comments, cursor)
    if (page.matched) return true
    cursor = page.nextCursor
  }
  return false
}

/**
 * List open pull requests in `repository` (`<owner>/<repo>`) that carry a supervisor provenance
 * comment (whose body starts with `PROVENANCE_MARKER`), paginating pull requests and comments.
 */
export async function listProvenancePulls(
  run: RunProcess,
  repository: string,
): Promise<ProvenancePull[]> {
  const [owner, repo] = repository.split('/') as [string, string]
  const pulls: ProvenancePull[] = []
  let cursor: string | undefined
  while (true) {
    const extra = cursor === undefined ? [] : ['-f', `cursor=${cursor}`]
    const data = await runGraphql(run, OPEN_PULLS_QUERY, owner, repo, extra)
    if (!isObject(data.repository)) {
      throw new PrToolError('not-found', `Repository ${repository} was not found.`)
    }
    const conn = data.repository.pullRequests
    if (!isObject(conn) || !Array.isArray(conn.nodes)) {
      badResponse('returned unexpected pullRequests payload')
    }
    for (const node of conn.nodes) {
      if (
        !isObject(node) ||
        typeof node.number !== 'number' ||
        typeof node.title !== 'string' ||
        typeof node.url !== 'string' ||
        typeof node.isDraft !== 'boolean'
      ) {
        badResponse('returned unexpected pull request node')
      }
      const firstPage = parseCommentsPage(node.comments, undefined)
      let matched = firstPage.matched
      if (!matched && firstPage.nextCursor !== undefined) {
        matched = await hasProvenanceInRemainingComments(
          run,
          owner,
          repo,
          repository,
          node.number,
          firstPage.nextCursor,
        )
      }
      if (matched) {
        pulls.push({
          repository,
          number: node.number,
          title: node.title,
          url: node.url,
          isDraft: node.isDraft,
        })
      }
    }
    cursor = parsePageInfo(conn.pageInfo, 'pullRequests', cursor)
    if (cursor === undefined) break
  }
  pulls.sort((a, b) => a.number - b.number)
  return pulls
}
