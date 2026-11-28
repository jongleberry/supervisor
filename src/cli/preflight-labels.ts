import type { LoadedConfig } from '../config/load.js'
import { parseRepoList, REPO_LIST_JQ, repoListEndpoint, selectRepos } from '../config/repos.js'
import type { Scope } from '../config/types.js'
import { isObject } from '../state/json.js'
import type { RunProcess } from '../state/process.js'
import { firstLine, type Check } from './preflight-checks.js'

const TIMEOUT_MS = 120_000
const LABEL_BATCH_SIZE = 25

interface RepoRef {
  owner: string
  name: string
}

async function runGh(run: RunProcess, args: string[]): Promise<string> {
  const result = await run('gh', args, { timeoutMs: TIMEOUT_MS })
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim()
    throw new Error(`gh exited ${result.code}: ${firstLine(output)}`)
  }
  return result.stdout
}

function groupByOwner(scopes: readonly Scope[]): Map<string, Scope[]> {
  const byOwner = new Map<string, Scope[]>()
  for (const scope of scopes) {
    const existing = byOwner.get(scope.owner)
    if (existing) {
      existing.push(scope)
    } else {
      byOwner.set(scope.owner, [scope])
    }
  }
  return byOwner
}

async function listEnforcedRepos(run: RunProcess, scopes: readonly Scope[]): Promise<RepoRef[]> {
  const repos: RepoRef[] = []
  let login: string | undefined
  for (const [owner, ownerScopes] of groupByOwner(scopes)) {
    const first = ownerScopes[0]!
    if (first.kind === 'user') {
      login ??= (await runGh(run, ['api', 'user', '--jq', '.login'])).trim()
    }
    const endpoint = repoListEndpoint(first, first.kind === 'user' ? login : undefined)
    const stdout = await runGh(run, ['api', '--paginate', endpoint, '--jq', REPO_LIST_JQ])
    for (const name of selectRepos(ownerScopes, parseRepoList(stdout))) {
      repos.push({ owner, name })
    }
  }
  return repos
}

function graphqlErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined
  }
  const first = errors[0]
  if (isObject(first) && typeof first.message === 'string' && first.message.trim() !== '') {
    return first.message
  }
  return 'GraphQL request returned errors'
}

async function checkBatch(
  run: RunProcess,
  batch: readonly RepoRef[],
  labelName: string,
): Promise<string[]> {
  const vars = ['$needsHuman:String!']
  const fields: string[] = []
  const args = ['api', 'graphql', '-f', `needsHuman=${labelName}`]
  for (let i = 0; i < batch.length; i += 1) {
    const repo = batch[i]!
    vars.push(`$o${i}:String!`, `$n${i}:String!`)
    fields.push(
      `r${i}:repository(owner:$o${i},name:$n${i}){needsHuman:label(name:$needsHuman){name}}`,
    )
    args.push('-f', `o${i}=${repo.owner}`, '-f', `n${i}=${repo.name}`)
  }
  args.splice(2, 0, '-f', `query=query(${vars.join(',')}){${fields.join(' ')}}`)

  const stdout = await runGh(run, args)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error('gh api graphql printed invalid JSON', { cause: error })
  }
  if (!isObject(parsed)) {
    throw new Error('gh api graphql returned an unexpected response')
  }
  const gqlError = graphqlErrorMessage(parsed.errors)
  if (gqlError !== undefined) {
    throw new Error(gqlError)
  }
  if (!isObject(parsed.data)) {
    throw new Error('gh api graphql returned no data')
  }

  const missing: string[] = []
  for (let i = 0; i < batch.length; i += 1) {
    const repo = batch[i]!
    const entry = parsed.data[`r${i}`]
    if (!isObject(entry)) {
      throw new Error(`repository ${repo.owner}/${repo.name} not found in GraphQL response`)
    }
    if (!isObject(entry.needsHuman)) {
      missing.push(`${repo.owner}/${repo.name} (${labelName})`)
    }
  }
  return missing
}

/**
 * Verify that configured `labels.needsHuman` exists in every repository selected by scopes in
 * `enforce` mode (plus any owner named with `--enforce-scope` for pre-switch rollout checks).
 * When `labels.needsHuman` is not configured, the check is skipped as ok. Missing labels are
 * reported in the detail with `ok: true` so preflight does not exit 1; creating labels is left to
 * a person.
 */
export async function checkLabels(
  run: RunProcess,
  loaded: LoadedConfig | undefined,
  ghOk: boolean,
  enforceScopes: readonly string[],
): Promise<Check> {
  const name = 'labels'
  if (loaded === undefined) {
    return { name, ok: false, detail: 'skipped: the config did not load' }
  }
  const knownOwners = new Set(loaded.config.scopes.map((scope) => scope.owner.toLowerCase()))
  const unknown = [
    ...new Set(enforceScopes.filter((owner) => !knownOwners.has(owner.toLowerCase()))),
  ]
  if (unknown.length > 0) {
    return { name, ok: false, detail: `unknown --enforce-scope: ${unknown.join(', ')}` }
  }
  const forced = new Set(enforceScopes.map((owner) => owner.toLowerCase()))
  const enforced = loaded.config.scopes.filter(
    (scope) => scope.mode !== 'report' || forced.has(scope.owner.toLowerCase()),
  )
  if (enforced.length === 0) {
    return { name, ok: true, detail: 'skipped: no scopes in enforce mode' }
  }
  const needsHuman = loaded.config.labels?.needsHuman
  if (needsHuman === undefined) {
    return { name, ok: true, detail: 'skipped: labels not configured' }
  }
  if (!ghOk) {
    return { name, ok: false, detail: 'skipped: gh check failed' }
  }
  try {
    const repos = await listEnforcedRepos(run, enforced)
    if (repos.length === 0) {
      return { name, ok: true, detail: 'no repositories matched' }
    }
    const missing: string[] = []
    for (let i = 0; i < repos.length; i += LABEL_BATCH_SIZE) {
      const batch = repos.slice(i, i + LABEL_BATCH_SIZE)
      missing.push(...(await checkBatch(run, batch, needsHuman)))
    }
    if (missing.length > 0) {
      return { name, ok: true, detail: `missing: ${missing.join('; ')}` }
    }
    const noun = repos.length === 1 ? 'repo' : 'repos'
    return {
      name,
      ok: true,
      detail: `${repos.length} ${noun} checked (${needsHuman})`,
    }
  } catch (error) {
    return { name, ok: false, detail: firstLine((error as Error).message) }
  }
}
