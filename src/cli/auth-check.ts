import { REPOSITORY } from '../policy/facts-gh.js'
import { stripCredentials } from '../pr/redact.js'
import { isObject } from '../state/json.js'
import type { RunProcess } from '../state/process.js'
import { firstLine } from './preflight-checks.js'

/** Permissions that grant push access or higher on a repository. */
const ALLOWED_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

/** Matches bot logins (`name[bot]`, `app/name`, `bot:name`); never authorized. */
const BOT_LOGIN = /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\[bot\]|(?:app\/|bot:)[A-Za-z0-9][A-Za-z0-9_-]*)$/i

/** Matches a non-bot GitHub login; rejects path segments, slashes, and query chars. */
const USER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Timeout for a single collaborator-permission API call. */
const TIMEOUT_MS = 30_000

const BOT_DETAIL = 'bot accounts are not authorized to run comment commands'

export type AuthDenialReason =
  | 'bot'
  | 'insufficient-permission'
  | 'not-collaborator'
  | 'api-error'
  | 'invalid-response'

export interface AuthCheckResult {
  allowed: boolean
  repository: string
  login: string
  permission: string | null
  roleName: string | null
  userType: string | null
  reason: AuthDenialReason | null
  detail: string
}

export function isValidRepository(repository: string): boolean {
  return REPOSITORY.test(repository)
}

export function isBotLogin(login: string): boolean {
  return BOT_LOGIN.test(login)
}

export function isValidLogin(login: string): boolean {
  return USER_LOGIN.test(login) || BOT_LOGIN.test(login)
}

function denied(
  repository: string,
  login: string,
  reason: AuthDenialReason,
  detail: string,
  extra: { permission?: string | null; roleName?: string | null; userType?: string | null } = {},
): AuthCheckResult {
  return {
    allowed: false,
    repository,
    login,
    permission: extra.permission ?? null,
    roleName: extra.roleName ?? null,
    userType: extra.userType ?? null,
    reason,
    detail,
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function isNotFound(stdout: string, stderr: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (isObject(parsed) && String(parsed.status) === '404') return true
  } catch {
    // Non-JSON stdout; fall back to stderr status check.
  }
  return /\bHTTP 404\b/.test(stderr)
}

function cleanDetail(text: string): string {
  return firstLine(stripCredentials(text).text)
}

function parsePermissionResponse(
  repository: string,
  login: string,
  stdout: string,
): AuthCheckResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return denied(repository, login, 'invalid-response', 'gh api returned invalid JSON')
  }
  if (!isObject(parsed)) {
    return denied(repository, login, 'invalid-response', 'gh api returned a non-object response')
  }
  const permission = nonEmptyString(parsed.permission)
  const roleName = nonEmptyString(parsed.role_name)
  const user = isObject(parsed.user) ? parsed.user : undefined
  const userLogin = nonEmptyString(user?.login)
  const userType = nonEmptyString(user?.type)

  if (userType?.toLowerCase() === 'bot' || (userLogin !== null && isBotLogin(userLogin))) {
    return denied(repository, login, 'bot', BOT_DETAIL, {
      permission,
      roleName,
      userType: userType ?? 'Bot',
    })
  }
  if (userLogin === null || userType === null) {
    return denied(repository, login, 'invalid-response', 'GitHub returned no user identity', {
      permission,
      roleName,
      userType,
    })
  }
  if (userType !== 'User') {
    return denied(
      repository,
      login,
      'invalid-response',
      `account type "${userType}" is not a User`,
      {
        permission,
        roleName,
        userType,
      },
    )
  }
  if (permission === null) {
    return denied(repository, login, 'invalid-response', 'GitHub returned no permission level', {
      roleName,
      userType,
    })
  }
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    const detail = `permission "${permission}" does not grant push access`
    return denied(repository, login, 'insufficient-permission', detail, {
      permission,
      roleName,
      userType,
    })
  }
  const detail =
    roleName !== null && roleName !== permission
      ? `allowed (${permission}, role ${roleName})`
      : `allowed (${permission})`
  return {
    allowed: true,
    repository,
    login,
    permission,
    roleName,
    userType,
    reason: null,
    detail,
  }
}

/**
 * Check live whether `login` is a non-bot collaborator with push access or higher
 * (`write`, `maintain`, or `admin`) on `repository`. Fails closed on any API or parse error
 * and stores nothing.
 */
export async function checkCollaboratorAuth(
  repository: string,
  login: string,
  run: RunProcess,
): Promise<AuthCheckResult> {
  if (isBotLogin(login)) {
    return denied(repository, login, 'bot', BOT_DETAIL, { userType: 'Bot' })
  }
  const endpoint = `repos/${repository}/collaborators/${login}/permission`
  let result
  try {
    result = await run('gh', ['api', endpoint], { timeoutMs: TIMEOUT_MS })
  } catch (error) {
    const detail = `gh api failed: ${cleanDetail((error as Error).message)}`
    return denied(repository, login, 'api-error', detail)
  }
  if (result.code !== 0) {
    if (isNotFound(result.stdout, result.stderr)) {
      const detail = `${login} is not a collaborator on ${repository} (HTTP 404)`
      return denied(repository, login, 'not-collaborator', detail)
    }
    const output = cleanDetail(result.stderr || result.stdout)
    const detail = output
      ? `gh api exited ${result.code}: ${output}`
      : `gh api exited ${result.code}`
    return denied(repository, login, 'api-error', detail)
  }
  return parsePermissionResponse(repository, login, result.stdout)
}
