import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyDefaults, expandHome } from '../src/config/defaults.js'
import { ConfigError, loadConfig, requireStateDir, resolveConfigPath } from '../src/config/load.js'
import {
  parseRepoList,
  repoListEndpoint,
  scopesForOwner,
  selectRepos,
} from '../src/config/repos.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/loop-config', import.meta.url))
const examplePath = fileURLToPath(new URL('../examples/config.example.json', import.meta.url))
const invalidJsonPath = fileURLToPath(new URL('./fixtures/invalid-json.txt', import.meta.url))
const invalidConfigPath = fileURLToPath(new URL('./fixtures/invalid-config.json', import.meta.url))

describe('loop config path resolution', () => {
  it('uses $SUPERVISOR_CONFIG, else .supervisor.json in the current directory', () => {
    expect(resolveConfigPath({ SUPERVISOR_CONFIG: '/etc/supervisor.json' }, '/work')).toBe(
      '/etc/supervisor.json',
    )
    expect(resolveConfigPath({ SUPERVISOR_CONFIG: '' }, '/work')).toBe('/work/.supervisor.json')
    expect(resolveConfigPath({}, '/work')).toBe('/work/.supervisor.json')
  })

  it('expands a leading ~/ and a bare ~ to the home directory, and nothing else', () => {
    expect(resolveConfigPath({ SUPERVISOR_CONFIG: '~/cfg.json' }, '/work')).toBe(
      join(homedir(), 'cfg.json'),
    )
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~other/dir')).toBe('~other/dir')
    expect(expandHome('relative/~/dir')).toBe('relative/~/dir')
  })
})

describe('loop config loading', () => {
  it('loads the example with paths expanded and written values kept', async () => {
    const { path, config } = await loadConfig({ SUPERVISOR_CONFIG: examplePath }, '/unused')
    expect(path).toBe(examplePath)
    expect(config.stateDir).toBe(join(homedir(), '.supervisor-state'))
    expect(config.scopes[0]!.checkoutRoot).toBe(join(homedir(), 'code/example-org'))
    expect(config.scopes[1]!.checkoutRoot).toBeUndefined()
    expect(config.staleRuns).toEqual({ olderThan: '6h', cancelAfter: '24h' })
    expect(config.finalReview.status).toBe('review-status')
    expect(config.sweepCap).toEqual({ issues: 10, dispatches: 5 })
  })

  it('fills in defaults for keys the file omits and keeps the ones it sets', async () => {
    const loaded = await loadConfig({}, fixtureDir)
    expect(loaded.path).toBe(join(fixtureDir, '.supervisor.json'))
    expect(loaded.config).toMatchObject({
      fallbackCron: '0 */6 * * *',
      lateReviewDays: 14,
      fullRescanDays: 7,
      layerCap: 10,
      sweepCap: { issues: 10, dispatches: 5 },
      scheduledPrompts: { glob: 'prompts/*.md', quota: 1, history: 5 },
      staleRuns: false,
      eventWait: { timeout: '90s', advance: false, updateCheckDelay: '10m' },
    })
    expect(loaded.config.scopes[0]!.checkoutRoot).toBe(homedir())
    expect(loaded.config.stateDir).toBeUndefined()
    expect(() => requireStateDir(loaded)).toThrow(ConfigError)
  })

  it('leaves scheduledPrompts absent, turns staleRuns on, and returns a set stateDir', async () => {
    const loaded = await loadConfig({ SUPERVISOR_CONFIG: examplePath }, '/unused')
    const { scheduledPrompts: _prompts, staleRuns: _stale, sweepCap: _cap, ...rest } = loaded.config
    const config = applyDefaults({
      ...rest,
      stateDir: '/var/state',
      labels: { automation: 'automation', needsHuman: 'needs-human' },
      eventWait: { hookHarness: '0.3.5', timeout: '30m' },
      sweepCap: { issues: 0 },
    })
    expect(config.labels).toEqual({ needsHuman: 'needs-human' })
    expect(applyDefaults({ ...rest, labels: { automation: 'automation' } }).labels).toEqual({})
    expect(config.scheduledPrompts).toBeUndefined()
    expect(config.staleRuns).toEqual({ olderThan: '6h', cancelAfter: '24h' })
    expect(config.sweepCap).toEqual({ issues: 0, dispatches: 5 })
    expect(applyDefaults({ ...rest, sweepCap: { dispatches: 0 } }).sweepCap).toEqual({
      issues: 10,
      dispatches: 0,
    })
    expect(config.eventWait).toEqual({
      timeout: '30m',
      advance: false,
      updateCheckDelay: '10m',
    })
    expect(requireStateDir({ path: examplePath, config })).toBe('/var/state')
  })

  it('names the file when it is missing, is not JSON, or breaks the schema', async () => {
    await expect(loadConfig({}, '/nonexistent-dir')).rejects.toThrow(
      /^supervisor config \/nonexistent-dir\/\.supervisor\.json: /,
    )
    await expect(loadConfig({}, '/nonexistent-dir')).rejects.toMatchObject({
      cause: { code: 'ENOENT' },
    })
    const badJson = await loadConfig({ SUPERVISOR_CONFIG: invalidJsonPath }, '/x').catch(
      (error: unknown) => error,
    )
    expect(badJson).toBeInstanceOf(ConfigError)
    expect((badJson as ConfigError).cause).toBeInstanceOf(SyntaxError)
    await expect(loadConfig({ SUPERVISOR_CONFIG: invalidConfigPath }, '/x')).rejects.toThrow(
      /\/scopes\/0\/kind: .*; /,
    )
  })
})

describe('repository selection', () => {
  it('finds every scope of an owner and rejects an owner with none', async () => {
    const loaded = await loadConfig({}, fixtureDir)
    expect(scopesForOwner(loaded, 'example-user').map((scope) => scope.kind)).toEqual(['user'])
    expect(() => scopesForOwner(loaded, 'example-other')).toThrow(/no scope has owner/)
  })

  it('lists an organization and a user through different endpoints', () => {
    expect(repoListEndpoint({ owner: 'example-org', kind: 'org', repos: '*' })).toBe(
      'orgs/example-org/repos?per_page=100',
    )
    const user = { owner: 'example-user', kind: 'user', repos: '*' } as const
    expect(repoListEndpoint(user)).toBe('users/example-user/repos?per_page=100')
    expect(repoListEndpoint(user, 'someone-else')).toBe('users/example-user/repos?per_page=100')
    expect(repoListEndpoint(user, 'Example-User')).toBe('user/repos?affiliation=owner&per_page=100')
  })

  it('parses the listing and applies repos, excludeForks and excludedRepos', () => {
    const listed = parseRepoList('zeta\tfalse\nalpha\ttrue\n\nbeta\tfalse\ngamma\tfalse\n')
    expect(listed).toContainEqual({ name: 'alpha', fork: true })
    expect(selectRepos([{ owner: 'o', kind: 'org', repos: '*' }], listed)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'zeta',
    ])
    expect(
      selectRepos(
        [{ owner: 'o', kind: 'org', repos: '*', excludeForks: true, excludedRepos: ['gamma'] }],
        listed,
      ),
    ).toEqual(['beta', 'zeta'])
    expect(
      selectRepos([{ owner: 'o', kind: 'org', repos: ['alpha', 'beta', 'missing'] }], listed),
    ).toEqual(['alpha', 'beta'])
  })

  it('unions the selections of two scopes for the same owner', () => {
    const listed = parseRepoList('alpha\tfalse\nbeta\tfalse\ngamma\tfalse\n')
    const scopes = [
      { owner: 'o', kind: 'org' as const, repos: ['beta', 'alpha'] },
      { owner: 'o', kind: 'org' as const, repos: ['beta'] },
    ]
    expect(selectRepos(scopes, listed)).toEqual(['alpha', 'beta'])
  })
})
