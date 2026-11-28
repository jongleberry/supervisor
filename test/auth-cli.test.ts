import { describe, expect, it, vi } from 'vitest'
import type { AuthCheckResult } from '../src/cli/auth-check.js'
import { runCli, type CliIo } from '../src/cli/run.js'
import type { ProcessResult, RunProcess } from '../src/state/process.js'

function createTestIo(runProcess: RunProcess) {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const io: CliIo = {
    env: {},
    stdout: (text) => stdoutChunks.push(text),
    stderr: (text) => stderrChunks.push(text),
    startMcp: vi.fn(async () => undefined),
    runProcess,
    shepherdStatus: vi.fn(),
    now: () => new Date(0),
  }
  return {
    io,
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join(''),
  }
}

function ghReply(
  result: Partial<ProcessResult> & { code?: number },
): ReturnType<typeof vi.fn<RunProcess>> {
  return vi.fn<RunProcess>(async () => ({
    code: result.code ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }))
}

describe('supervisor auth CLI', () => {
  it('prints help for auth and auth check', async () => {
    for (const argv of [
      ['auth', '--help'],
      ['auth', '-h'],
      ['auth', 'check', '--help'],
      ['auth', 'check', '-h'],
    ]) {
      const testIo = createTestIo(vi.fn<RunProcess>())
      expect(await runCli(argv, testIo.io)).toBe(0)
      expect(testIo.stdout()).toContain('Usage: supervisor auth check <owner>/<repo> <login>')
      expect(testIo.stderr()).toBe('')
    }
  })

  it('exits 0 for allowed and 1 for denied in plain and --json modes without config', async () => {
    const allowedIo = createTestIo(
      ghReply({
        stdout: JSON.stringify({
          permission: 'write',
          role_name: 'write',
          user: { login: 'example-user', type: 'User' },
        }),
      }),
    )
    expect(
      await runCli(['auth', 'check', 'example-org/example-repo', 'example-user'], allowedIo.io),
    ).toBe(0)
    expect(allowedIo.stdout()).toBe(
      'allowed example-org/example-repo example-user: allowed (write)\n',
    )
    expect(allowedIo.stderr()).toBe('')

    const deniedIo = createTestIo(
      ghReply({
        stdout: JSON.stringify({
          permission: 'read',
          role_name: 'read',
          user: { login: 'example-user', type: 'User' },
        }),
      }),
    )
    expect(
      await runCli(
        ['auth', 'check', 'example-org/example-repo', 'example-user', '--json'],
        deniedIo.io,
      ),
    ).toBe(1)
    expect(JSON.parse(deniedIo.stdout())).toEqual<AuthCheckResult>({
      allowed: false,
      repository: 'example-org/example-repo',
      login: 'example-user',
      permission: 'read',
      roleName: 'read',
      userType: 'User',
      reason: 'insufficient-permission',
      detail: 'permission "read" does not grant push access',
    })
    expect(deniedIo.stderr()).toBe('')

    const plainDeniedIo = createTestIo(vi.fn<RunProcess>())
    expect(
      await runCli(
        ['auth', 'check', 'example-org/example-repo', 'dependabot[bot]'],
        plainDeniedIo.io,
      ),
    ).toBe(1)
    expect(plainDeniedIo.stdout()).toBe(
      'denied example-org/example-repo dependabot[bot]: bot accounts are not authorized to run comment commands\n',
    )
  })

  it('exits 2 on usage errors, bad repo names, and unsafe logins without calling gh', async () => {
    const cases: string[][] = [
      ['auth'],
      ['auth', 'unknown'],
      ['auth', 'check'],
      ['auth', 'check', 'example-org/example-repo'],
      ['auth', 'check', 'example-org/example-repo', 'example-user', 'extra'],
      ['auth', 'check', '--unknown', 'example-org/example-repo', 'example-user'],
      ['auth', 'check', 'not-a-repo', 'example-user'],
      ['auth', 'check', '../evil', 'example-user'],
      ['auth', 'check', 'example-org/..', 'example-user'],
      ['auth', 'check', 'example-org/example-repo', '..'],
      ['auth', 'check', 'example-org/example-repo', 'alice/bob'],
      ['auth', 'check', 'example-org/example-repo', 'alice?x=1'],
      ['auth', 'check', 'example-org/example-repo', 'bad.login'],
    ]
    for (const argv of cases) {
      const run = vi.fn<RunProcess>()
      const testIo = createTestIo(run)
      expect(await runCli(argv, testIo.io)).toBe(2)
      expect(testIo.stderr()).toContain('Usage: supervisor auth check')
      expect(run).not.toHaveBeenCalled()
    }
  })
})
