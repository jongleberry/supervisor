import { startMcpServer } from '../mcp/server.js'
import type { ShepherdStatus } from '../policy/facts-readiness.js'
import { runProcess, type RunProcess } from '../state/process.js'
import { runAuthCommand } from './auth-cmd.js'
import { validateConfigFile } from './config-validate.js'
import { runPolicyCommand } from './policy-cmd.js'
import { runPreflightCommand } from './preflight-cmd.js'
import { runPrepushCommand } from './prepush-cmd.js'
import { shepherdStatus } from './shepherd-status.js'
import { runStateCommand } from './state-cmd.js'
import { runStopCommand } from './stop-cmd.js'
import { getVersion } from './version.js'
import { runWaitCommand } from './wait-cmd.js'

export interface CliIo {
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
  startMcp: (version: string) => Promise<unknown>
  /** Runs `gh` and other external commands; tests replace it so nothing is spawned. */
  runProcess: RunProcess
  /** pr-shepherd's read-only status; tests replace it so nothing is read from GitHub. */
  shepherdStatus: ShepherdStatus
  now: () => Date
  /** HTTP transport for in-process relay polling; defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Sleep between relay polls; defaults to hook-harness's timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Timeout signal factory for relay polling; defaults to `AbortSignal.timeout`. */
  timeoutSignal?: (ms: number) => AbortSignal
}

export const defaultCliIo: CliIo = {
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  startMcp: startMcpServer,
  runProcess,
  shepherdStatus,
  now: () => new Date(),
}

const HELP_TEXT = `Usage: supervisor <command> [options]

Commands:
  auth check <owner>/<repo> <login> [--json]
                                       Check live whether a user may run comment commands on a repo
  config validate [path]               Validate a config JSON file (defaults to $SUPERVISOR_CONFIG)
  policy explain <dir> [path]          Explain policy rules for a repo or path
  policy check <owner>/<repo> <pr> [--dir <d>]
                                       Read a PR from GitHub and evaluate it against policies
  policy check [--dir <d>] --input <f> Evaluate a written input file against policies
  policy classify-prepare <owner>/<repo> <pr> --dir <d> --out <o>
                                       Write the input file for each repo/<name> classifier
  policy classify-collect --out <o> [--reviewer <a>]
                                       Check answers, map final review, and write classifier results
  prepush [--range <a>..<b>]           Scan outgoing commits for private names, emails, hostnames
  prepush install                      Install the git pre-push hook
  state <subcommand> [options]         Update the loop's state.json (see: supervisor state --help)
  wait [--advance]                     Wait for events of every owner that need action
  stop [--reason <text>]               Set the stop switch: the supervisor takes no action
  stop --status                        Report the stop switch (exit 3 when it is set)
  resume                               Clear the stop switch
  preflight [--json] [--enforce-scope <owner>...]
                                       Check supervisor, config, gh, pr-shepherd, hook-harness, stop, and labels
  mcp                                  Start the stdio MCP server

Options:
  -h, --help                           Show help
  -V, --version                        Show version
`

async function runConfigCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand !== 'validate') {
    io.stderr(`Unknown config subcommand: ${subcommand ?? '(none)'}\n${HELP_TEXT}`)
    return 2
  }
  if (rest.length > 1) {
    io.stderr(`Unexpected arguments: ${rest.slice(1).join(' ')}\n${HELP_TEXT}`)
    return 2
  }
  const target = rest[0] || io.env.SUPERVISOR_CONFIG
  if (!target) {
    io.stderr('Missing config path: pass a file path or set SUPERVISOR_CONFIG\n')
    return 2
  }
  const result = await validateConfigFile(target)
  if (result.valid) {
    io.stdout(`Valid: ${target}\n`)
    return 0
  }
  for (const error of result.errors) {
    io.stderr(`${error.path}: ${error.message}\n`)
  }
  return 1
}

export async function runCli(argv: string[], io: CliIo = defaultCliIo): Promise<number> {
  const [command, ...rest] = argv
  if (!command) {
    io.stderr(HELP_TEXT)
    return 2
  }
  if (command === '--help' || command === '-h') {
    io.stdout(HELP_TEXT)
    return 0
  }
  if (command === '--version' || command === '-V') {
    io.stdout(`${getVersion()}\n`)
    return 0
  }
  if (command === 'auth') {
    return await runAuthCommand(rest, io)
  }
  if (command === 'config') {
    return await runConfigCommand(rest, io)
  }
  if (command === 'policy') {
    return await runPolicyCommand(rest, io)
  }
  if (command === 'prepush') {
    return await runPrepushCommand(rest, io)
  }
  if (command === 'state') {
    return await runStateCommand(rest, io)
  }
  if (command === 'wait') {
    return await runWaitCommand(rest, io)
  }
  if (command === 'stop' || command === 'resume') {
    return await runStopCommand(command, rest, io)
  }
  if (command === 'preflight') {
    return await runPreflightCommand(rest, io)
  }
  if (command === 'mcp') {
    if (rest.length > 0) {
      io.stderr(`Unexpected arguments for mcp: ${rest.join(' ')}\n${HELP_TEXT}`)
      return 2
    }
    await io.startMcp(getVersion())
    return 0
  }
  io.stderr(`Unknown command: ${command}\n${HELP_TEXT}`)
  return 2
}
