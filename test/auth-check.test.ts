import { describe, expect, it, vi } from 'vitest'
import { checkCollaboratorAuth, type AuthCheckResult } from '../src/cli/auth-check.js'
import type { ProcessResult, RunProcess } from '../src/state/process.js'

const REPO = 'example-org/example-repo'

function ghReply(
  result: Partial<ProcessResult> & { code?: number },
): ReturnType<typeof vi.fn<RunProcess>> {
  return vi.fn<RunProcess>(async () => ({
    code: result.code ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }))
}

function payload(
  permission: string,
  options: { roleName?: string | undefined; login?: string; type?: string } = {},
): string {
  return JSON.stringify({
    permission,
    ...(options.roleName === undefined ? {} : { role_name: options.roleName }),
    user: { login: options.login ?? 'example-user', type: options.type ?? 'User' },
  })
}

describe('collaborator auth check', () => {
  it('allows admin, maintain, and write permissions for non-bot Users', async () => {
    const cases = [
      { permission: 'admin', roleName: 'admin', detail: 'allowed (admin)' },
      { permission: 'maintain', roleName: 'maintain', detail: 'allowed (maintain)' },
      { permission: 'write', roleName: 'maintain', detail: 'allowed (write, role maintain)' },
      { permission: 'write', roleName: 'write', detail: 'allowed (write)' },
      { permission: 'write', roleName: undefined, detail: 'allowed (write)' },
    ]
    for (const c of cases) {
      const run = ghReply({ stdout: payload(c.permission, { roleName: c.roleName }) })
      expect(await checkCollaboratorAuth(REPO, 'example-user', run)).toEqual<AuthCheckResult>({
        allowed: true,
        repository: REPO,
        login: 'example-user',
        permission: c.permission,
        roleName: c.roleName ?? null,
        userType: 'User',
        reason: null,
        detail: c.detail,
      })
      expect(run).toHaveBeenCalledWith(
        'gh',
        ['api', `repos/${REPO}/collaborators/example-user/permission`],
        { timeoutMs: 30_000 },
      )
    }
  })

  it('denies triage, read, none, and unknown permission levels', async () => {
    const cases = [
      { permission: 'read', roleName: 'triage' },
      { permission: 'triage', roleName: 'triage' },
      { permission: 'read', roleName: 'read' },
      { permission: 'none', roleName: 'none' },
      { permission: 'custom-read-only', roleName: 'custom-read-only' },
    ]
    for (const c of cases) {
      const run = ghReply({ stdout: payload(c.permission, { roleName: c.roleName }) })
      expect(await checkCollaboratorAuth(REPO, 'example-user', run)).toEqual<AuthCheckResult>({
        allowed: false,
        repository: REPO,
        login: 'example-user',
        permission: c.permission,
        roleName: c.roleName,
        userType: 'User',
        reason: 'insufficient-permission',
        detail: `permission "${c.permission}" does not grant push access`,
      })
    }
  })

  it('denies a 404 response for a non-collaborator from JSON status or stderr', async () => {
    const fromJson = ghReply({
      code: 1,
      stdout: '{"message":"Not Found","status":"404"}',
      stderr: 'gh: Not Found (HTTP 404)\n',
    })
    expect(await checkCollaboratorAuth(REPO, 'outsider', fromJson)).toMatchObject({
      allowed: false,
      reason: 'not-collaborator',
      permission: null,
      roleName: null,
      userType: null,
    })

    const fromStderr = ghReply({
      code: 1,
      stdout: 'not json',
      stderr: 'gh: outsider is not a user (HTTP 404)\n',
    })
    expect(await checkCollaboratorAuth(REPO, 'outsider', fromStderr)).toMatchObject({
      allowed: false,
      reason: 'not-collaborator',
    })
  })

  it('denies bot logins without calling gh', async () => {
    for (const login of ['dependabot[bot]', 'Dependabot[BOT]', 'app/dependabot', 'bot:helper']) {
      const run = vi.fn<RunProcess>()
      expect(await checkCollaboratorAuth(REPO, login, run)).toEqual<AuthCheckResult>({
        allowed: false,
        repository: REPO,
        login,
        permission: null,
        roleName: null,
        userType: 'Bot',
        reason: 'bot',
        detail: 'bot accounts are not authorized to run comment commands',
      })
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('denies Bot user.type or bot user.login from the API even with admin permission', async () => {
    const botTypeRun = ghReply({
      stdout: payload('admin', { roleName: 'admin', login: 'ci-helper', type: 'Bot' }),
    })
    expect(await checkCollaboratorAuth(REPO, 'ci-helper', botTypeRun)).toMatchObject({
      allowed: false,
      reason: 'bot',
      permission: 'admin',
      userType: 'Bot',
    })

    const botLoginRun = ghReply({ stdout: '{"permission":"write","user":{"login":"ci[bot]"}}' })
    expect(await checkCollaboratorAuth(REPO, 'ci', botLoginRun)).toMatchObject({
      allowed: false,
      reason: 'bot',
      userType: 'Bot',
    })
  })

  it('fails closed on API errors, process errors, and redacts tokens in error details', async () => {
    const token = 'ghp_123456789012345678901234567890'
    const rateLimited = ghReply({
      code: 1,
      stdout: '{"message":"API rate limit exceeded","status":"403"}',
      stderr: `gh: API rate limit exceeded with ${token} (HTTP 403)\n`,
    })
    const rateResult = await checkCollaboratorAuth(REPO, 'example-user', rateLimited)
    expect(rateResult).toMatchObject({ allowed: false, reason: 'api-error', permission: null })
    expect(rateResult.detail).toContain('[REDACTED]')
    expect(rateResult.detail).not.toContain(token)

    const cases = [
      {
        run: ghReply({ code: 1, stdout: 'unavailable\n' }),
        detail: 'gh api exited 1: unavailable',
      },
      { run: ghReply({ code: 1 }), detail: 'gh api exited 1' },
      {
        run: vi.fn<RunProcess>(async () => {
          throw new Error('spawn gh ENOENT')
        }),
        detail: 'gh api failed: spawn gh ENOENT',
      },
    ]
    for (const c of cases) {
      expect(await checkCollaboratorAuth(REPO, 'example-user', c.run)).toMatchObject({
        allowed: false,
        reason: 'api-error',
        detail: c.detail,
      })
    }
  })

  it('fails closed on malformed payloads, missing fields, or non-User account types', async () => {
    const cases = [
      { stdout: 'not-json', fragment: 'invalid JSON' },
      { stdout: '[]', fragment: 'non-object' },
      { stdout: '{"permission":"write","user":null}', fragment: 'no user identity' },
      { stdout: '{"permission":"write","user":{"login":"u"}}', fragment: 'no user identity' },
      {
        stdout: '{"permission":"write","user":{"login":"org","type":"Organization"}}',
        fragment: 'not a User',
      },
      { stdout: '{"user":{"login":"u","type":"User"}}', fragment: 'no permission level' },
    ]
    for (const c of cases) {
      const result = await checkCollaboratorAuth(
        REPO,
        'example-user',
        ghReply({ stdout: c.stdout }),
      )
      expect(result).toMatchObject({ allowed: false, reason: 'invalid-response' })
      expect(result.detail).toContain(c.fragment)
    }
  })
})
