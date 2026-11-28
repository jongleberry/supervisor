import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_COMMAND, MIN_CLI_VERSION } from '../src/cli/version.js'
import { cleanupLoops, done, makeLoop, NOW, TEST_RELAY_URL } from './helpers/loop.js'
import { fake, GOOD } from './helpers/preflight.js'

describe('supervisor preflight', () => {
  afterEach(cleanupLoops)

  it('prints help without a config and is listed in the main help', async () => {
    const loop = await makeLoop()
    loop.env.SUPERVISOR_CONFIG = '/nonexistent/config.json'
    const help = await loop.cli(['preflight', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(
      /^Usage: supervisor preflight \[--json\] \[--enforce-scope <owner>\.\.\.\]\n/,
    )
    expect((await loop.cli(['--help'])).stdout).toContain(
      '  preflight [--json] [--enforce-scope <owner>...]',
    )
  })

  it('rejects an unknown option', async () => {
    const loop = await makeLoop()
    const result = await loop.cli(['preflight', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^supervisor preflight: /)
  })

  it('reports every check on one line each and exits 0 when all are ok', async () => {
    const loop = await makeLoop()
    const { run, seen } = fake(GOOD)
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines).toEqual([
      `ok   supervisor: ${MIN_CLI_VERSION}`,
      `ok   config: ${loop.env.SUPERVISOR_CONFIG}`,
      'ok   gh: scopes: repo, read:org',
      'ok   pr-shepherd: pr-shepherd 1.2.3',
      `ok   hook-harness: ${TEST_RELAY_URL}`,
      'ok   stop: not stopped',
      'ok   labels: 1 repo checked (needs-human)',
    ])
    expect(seen.slice(0, 3)).toEqual([
      'supervisor --version',
      'gh auth status',
      'pr-shepherd --version',
    ])
    expect(seen[3]).toContain('gh api --paginate orgs/example-org/repos?per_page=100')
    expect(seen[4]).toContain('gh api graphql')
  })

  it('prints one JSON object with --json', async () => {
    const loop = await makeLoop()
    const result = await loop.cli(['preflight', '--json'], fake(GOOD).run)
    expect(result.code).toBe(0)
    const data = JSON.parse(result.stdout)
    expect(data.ok).toBe(true)
    expect(data.checks.map((check: { name: string }) => check.name)).toEqual([
      'supervisor',
      'config',
      'gh',
      'pr-shepherd',
      'hook-harness',
      'stop',
      'labels',
    ])
  })

  it('reports ok without checking hook-harness credentials when eventWait is not configured', async () => {
    const loop = await makeLoop({ eventWait: undefined })
    delete loop.env.HOOK_HARNESS_URL
    delete loop.env.HOOK_HARNESS_TOKEN
    const { run, seen } = fake(GOOD)
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok   hook-harness: not configured\n')
    expect(seen.slice(0, 3)).toEqual([
      'supervisor --version',
      'gh auth status',
      'pr-shepherd --version',
    ])
  })

  it('fails when the supervisor CLI is older than the minimum and passes at or above it', async () => {
    const loop = await makeLoop()
    for (const older of ['0.3.0', '0.4.0', '0.4.9', '0.5.0-rc.1']) {
      const result = await loop.cli(
        ['preflight', '--json'],
        fake({ ...GOOD, supervisor: done(`${older}\n`) }).run,
      )
      expect(result.code).toBe(1)
      const data = JSON.parse(result.stdout)
      expect(data.ok).toBe(false)
      expect(data.checks[0]).toEqual({
        name: 'supervisor',
        ok: false,
        detail: `${older} is older than ${MIN_CLI_VERSION}; run: ${INSTALL_COMMAND}`,
      })
    }
    for (const newer of ['0.5.0', '0.5.1', '1.0.0', 'v0.5.0', '0.5.0+build.1']) {
      const result = await loop.cli(
        ['preflight'],
        fake({ ...GOOD, supervisor: done(`${newer}\n`) }).run,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`ok   supervisor: ${newer}\n`)
    }
    const invalid = await loop.cli(
      ['preflight'],
      fake({ ...GOOD, supervisor: done('not-a-version\n') }).run,
    )
    expect(invalid.code).toBe(1)
    expect(invalid.stdout).toContain(
      `FAIL supervisor: cannot parse version "not-a-version"; need ${MIN_CLI_VERSION} or newer, run: ${INSTALL_COMMAND}\n`,
    )
    const missing = await loop.cli(
      ['preflight'],
      fake({ ...GOOD, supervisor: new Error('spawn supervisor ENOENT') }).run,
    )
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain(
      `FAIL supervisor: spawn supervisor ENOENT; need ${MIN_CLI_VERSION} or newer, run: ${INSTALL_COMMAND}\n`,
    )
  })

  it('fails on a gh that is not signed in, or has no scopes line, or cannot be run', async () => {
    const loop = await makeLoop()
    const out = await loop.cli(
      ['preflight'],
      fake({ ...GOOD, gh: done('', 1, 'not logged in') }).run,
    )
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('FAIL gh: exited 1: not logged in\n')
    const plain = await loop.cli(['preflight'], fake({ ...GOOD, gh: done('Logged in') }).run)
    expect(plain.stdout).toContain('ok   gh: authenticated\n')
    const missing = await loop.cli(
      ['preflight'],
      fake({ ...GOOD, gh: new Error('spawn gh ENOENT') }).run,
    )
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain('FAIL gh: spawn gh ENOENT\n')
  })

  it('fails on a tool whose version cannot be read', async () => {
    const loop = await makeLoop()
    const replies = { ...GOOD, 'pr-shepherd': done('', 127, 'not found') }
    const result = await loop.cli(['preflight'], fake(replies).run)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('FAIL pr-shepherd: exited 127: not found\n')
    const spawnFails = { ...GOOD, 'pr-shepherd': new Error('spawn pr-shepherd ENOENT') }
    const gone = await loop.cli(['preflight'], fake(spawnFails).run)
    expect(gone.stdout).toContain('FAIL pr-shepherd: spawn pr-shepherd ENOENT\n')
    const stderrOnly = { ...GOOD, 'pr-shepherd': done('', 0, 'pr-shepherd 1.2.3') }
    const old = await loop.cli(['preflight'], fake(stderrOnly).run)
    expect(old.stdout).toContain('ok   pr-shepherd: pr-shepherd 1.2.3\n')
  })

  it('fails when the stop switch is set, saying since when and why', async () => {
    const loop = await makeLoop()
    await loop.cli(['stop', '--reason', 'CI is broken'])
    const result = await loop.cli(['preflight', '--json'], fake(GOOD).run)
    expect(result.code).toBe(1)
    const stop = JSON.parse(result.stdout).checks.find(
      (check: { name: string }) => check.name === 'stop',
    )
    expect(stop).toEqual({ name: 'stop', ok: false, detail: `stopped since ${NOW}: CI is broken` })
    await loop.cli(['resume'])
    await writeFile(join(loop.stateDir, 'stop'), '')
    const bare = await loop.cli(['preflight'], fake(GOOD).run)
    expect(bare.stdout).toContain('FAIL stop: stopped\n')
  })

  it('fails the stop check when the config sets no stateDir', async () => {
    const loop = await makeLoop({ stateDir: undefined })
    const result = await loop.cli(['preflight'], fake(GOOD).run)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('FAIL stop: ')
    expect(result.stdout).toContain('stateDir is required')
  })

  it('still runs supervisor, gh, and pr-shepherd when the config does not load', async () => {
    const loop = await makeLoop()
    loop.env.SUPERVISOR_CONFIG = '/nonexistent/config.json'
    const { run, seen } = fake(GOOD)
    const result = await loop.cli(['preflight'], run)
    expect(result.code).toBe(1)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe(`ok   supervisor: ${MIN_CLI_VERSION}`)
    expect(lines[1]).toMatch(/^FAIL config: supervisor config \/nonexistent\/config.json: /)
    expect(lines[2]).toBe('ok   gh: scopes: repo, read:org')
    expect(lines[3]).toBe('ok   pr-shepherd: pr-shepherd 1.2.3')
    expect(lines[4]).toBe('FAIL hook-harness: skipped: the config did not load')
    expect(lines[5]).toBe('FAIL stop: unknown: the config did not load')
    expect(lines[6]).toBe('FAIL labels: skipped: the config did not load')
    expect(seen).toEqual(['supervisor --version', 'gh auth status', 'pr-shepherd --version'])
  })
})
