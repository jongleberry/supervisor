import { parseArgs } from 'node:util'
import { loadConfig, type LoadedConfig } from '../config/load.js'
import { FLAG } from '../state/context.js'
import { dumps } from '../state/json.js'
import {
  checkGh,
  checkHarness,
  checkShepherd,
  checkStop,
  checkSupervisor,
  firstLine,
  type Check,
} from './preflight-checks.js'
import { checkLabels } from './preflight-labels.js'
import type { CliIo } from './run.js'
import { MIN_CLI_VERSION } from './version.js'

const PREFLIGHT_HELP = `Usage: supervisor preflight [--json] [--enforce-scope <owner>...]

Checks, in one command, what a supervisor loop needs before it starts. Each check is reported as
name, ok, and detail:

  supervisor    "supervisor --version" succeeds and is ${MIN_CLI_VERSION} or newer; the detail is
                the version
  config        The config file loads and validates ($SUPERVISOR_CONFIG, else .supervisor.json
                in the current directory)
  gh            "gh auth status" succeeds; the detail lists the token scopes when gh prints them
  pr-shepherd   "pr-shepherd --version" succeeds; the detail is the version
  hook-harness  The hook-harness relay URL (https:, or http: only for localhost, 127.0.0.1, or
                [::1]) and token are configured via HOOK_HARNESS_URL/HOOK_HARNESS_TOKEN or
                hook-harness login; the detail is the relay origin. Reported ok, with the detail
                "not configured", when the config file does not set eventWait (the loop then paces
                with wake-ups)
  stop          The stop switch is not set (see: supervisor stop --help); when it is set, the
                detail says since when and why, and the check is not ok
  labels        Configured labels.needsHuman exists in every repository selected by scopes in
                enforce mode (and any owner passed via --enforce-scope). Reported ok with
                "skipped: no scopes in enforce mode" when every scope is in report mode, or
                "skipped: labels not configured" when labels.needsHuman is not configured.
                Missing repository labels are reported in the detail ("missing: ...") with ok
                status so preflight does not exit 1; labels are never created automatically

When the config does not load, config fails, hook-harness, stop, and labels are not ok (they need
it), and supervisor, gh, and pr-shepherd still run. Exit 0 when every check is ok, 1 otherwise.

Output is one line per check, "ok" or "FAIL", the name, and the detail. With --json it is one JSON
object, {"ok": <bool>, "checks": [{"name", "ok", "detail"}]}.

Options:
  --json                   Print the JSON object instead of lines
  --enforce-scope <owner>  Treat this configured scope owner as enforce for the labels check
                           (repeatable, for pre-switch rollout checks)
  -h, --help               Show help
`

async function checkConfig(io: CliIo): Promise<{ check: Check; loaded?: LoadedConfig }> {
  try {
    const loaded = await loadConfig(io.env, process.cwd())
    return { check: { name: 'config', ok: true, detail: loaded.path }, loaded }
  } catch (error) {
    return { check: { name: 'config', ok: false, detail: firstLine((error as Error).message) } }
  }
}

export async function runPreflightCommand(args: string[], io: CliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(PREFLIGHT_HELP)
    return 0
  }
  let json: boolean
  let enforceScopes: string[]
  try {
    const parsed = parseArgs({
      args,
      options: {
        json: FLAG,
        'enforce-scope': { type: 'string', multiple: true },
      },
    })
    json = parsed.values.json === true
    enforceScopes = parsed.values['enforce-scope'] ?? []
  } catch (error) {
    io.stderr(`supervisor preflight: ${(error as Error).message}\n${PREFLIGHT_HELP}`)
    return 2
  }
  const { check, loaded } = await checkConfig(io)
  const supervisor = await checkSupervisor(io.runProcess)
  const gh = await checkGh(io.runProcess)
  const checks = [
    supervisor,
    check,
    gh,
    await checkShepherd(io.runProcess),
    await checkHarness(io.env, loaded),
    await checkStop(loaded),
    await checkLabels(io.runProcess, loaded, gh.ok, enforceScopes),
  ]
  const ok = checks.every((entry) => entry.ok)
  if (json) {
    io.stdout(`${dumps({ ok, checks: checks.map((entry) => ({ ...entry })) })}\n`)
  } else {
    for (const entry of checks) {
      io.stdout(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}: ${entry.detail}\n`)
    }
  }
  return ok ? 0 : 1
}
