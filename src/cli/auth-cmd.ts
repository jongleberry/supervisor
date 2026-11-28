import { parseArgs } from 'node:util'
import { FLAG } from '../state/context.js'
import { dumps } from '../state/json.js'
import { checkCollaboratorAuth, isValidLogin, isValidRepository } from './auth-check.js'
import type { CliIo } from './run.js'

const AUTH_HELP = `Usage: supervisor auth check <owner>/<repo> <login> [--json]

Checks live whether <login> is authorized to run comment commands (/shepherd, /plan, /fix) on
<owner>/<repo> by reading GET /repos/<owner>/<repo>/collaborators/<login>/permission through
"gh api".

Allows only non-bot User accounts with push access or higher (write, maintain, or admin).
Read, triage, and none permissions, non-collaborators (404), bots, and API errors fail closed.
Reads no configuration file and stores nothing in state.

Exit codes:
  0  Allowed (non-bot collaborator with push access or higher)
  1  Denied (insufficient permission, non-collaborator, bot, or API error)
  2  Usage error (invalid arguments or options)

Options:
  --json       Print one JSON object: {"allowed", "repository", "login", "permission",
               "roleName", "userType", "reason", "detail"}
  -h, --help   Show help
`

async function runAuthCheck(args: string[], io: CliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(AUTH_HELP)
    return 0
  }
  let json: boolean
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args,
      options: { json: FLAG },
      allowPositionals: true,
    })
    json = parsed.values.json === true
    positionals = parsed.positionals
  } catch (error) {
    io.stderr(`supervisor auth check: ${(error as Error).message}\n${AUTH_HELP}`)
    return 2
  }
  if (positionals.length !== 2) {
    io.stderr(`supervisor auth check: expected <owner>/<repo> <login>\n${AUTH_HELP}`)
    return 2
  }
  const [repository, login] = positionals as [string, string]
  if (!isValidRepository(repository)) {
    io.stderr(`supervisor auth check: '${repository}' must look like <owner>/<repo>\n${AUTH_HELP}`)
    return 2
  }
  if (!isValidLogin(login)) {
    io.stderr(`supervisor auth check: '${login}' is not a valid GitHub login\n${AUTH_HELP}`)
    return 2
  }
  const result = await checkCollaboratorAuth(repository, login, io.runProcess)
  if (json) {
    io.stdout(`${dumps({ ...result })}\n`)
  } else {
    const verdict = result.allowed ? 'allowed' : 'denied'
    io.stdout(`${verdict} ${result.repository} ${result.login}: ${result.detail}\n`)
  }
  return result.allowed ? 0 : 1
}

export async function runAuthCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand === '--help' || subcommand === '-h') {
    io.stdout(AUTH_HELP)
    return 0
  }
  if (subcommand === 'check') {
    return await runAuthCheck(rest, io)
  }
  io.stderr(`Unknown auth subcommand: ${subcommand ?? '(none)'}\n${AUTH_HELP}`)
  return 2
}
