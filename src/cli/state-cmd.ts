import { DEFAULT_PROMPT_HISTORY } from '../config/defaults.js'
import { loadConfig, requireStateDir } from '../config/load.js'
import { advanceHookHarness, lateReview, updateCheck } from '../state/commands-external.js'
import { mergeRecord, mergeRecords } from '../state/commands-merge.js'
import { appendValue, removeValue, setValue } from '../state/commands-path.js'
import { scheduledPromptNext, scheduledPromptRecord } from '../state/commands-prompts.js'
import { annotateRoute, reviewed, route, show, sweepDone } from '../state/commands-records.js'
import { sweepStart } from '../state/commands-sweep.js'
import { watch } from '../state/commands-watch.js'
import { isUsageError, UsageError, type StateContext } from '../state/context.js'
import { dumps } from '../state/json.js'
import { refuseWhenStopped, StoppedError, STOPPED_EXIT } from '../state/stop.js'
import { timestamp, withStateLock } from '../state/store.js'
import type { CliIo } from './run.js'
import { STATE_HELP } from './state-help.js'

type Locked = (args: string[], ctx: StateContext) => Promise<void>

/** The subcommands that hold the state lock for their whole read-modify-write. */
const LOCKED: Record<string, Locked> = {
  show,
  set: setValue,
  append: appendValue,
  remove: removeValue,
  'sweep-start': sweepStart,
  'sweep-done': sweepDone,
  'merge-record': mergeRecord,
  'advance-hh': advanceHookHarness,
  route,
  'annotate-route': annotateRoute,
  'sp-record': scheduledPromptRecord,
  'sp-next': scheduledPromptNext,
  reviewed,
  watch,
}

/** The subcommands that read only, or call the forge, and take no lock. */
const UNLOCKED: Record<string, (args: string[], ctx: StateContext) => Promise<number>> = {
  'late-review': lateReview,
  'merge-records': mergeRecords,
  'update-check-script': async (args, ctx) => {
    updateCheck(args, ctx)
    return 0
  },
}

/** The subcommands that start or allow an action, so they refuse while the stop switch is set. */
const ACTS = ['sweep-start', 'merge-record']

async function dispatch(name: string, args: string[], ctx: StateContext): Promise<number> {
  if (Object.hasOwn(UNLOCKED, name)) {
    return await UNLOCKED[name]!(args, ctx)
  }
  const command = Object.hasOwn(LOCKED, name) ? LOCKED[name] : undefined
  if (command === undefined) {
    throw new UsageError(`unknown subcommand: ${name}`)
  }
  if (ACTS.includes(name)) {
    // Checked before the lock is taken, so a stuck lock never delays the refusal.
    await refuseWhenStopped(ctx.dir, `supervisor state ${name}`)
  }
  return await withStateLock(ctx.dir, async () => {
    await command(args, ctx)
    return 0
  })
}

export async function runStateCommand(args: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = args
  if (name === undefined) {
    io.stderr(STATE_HELP)
    return 2
  }
  if ([name, rest[0]].some((arg) => arg === '--help' || arg === '-h')) {
    io.stdout(STATE_HELP)
    return 0
  }
  try {
    const loaded = await loadConfig(io.env, process.cwd())
    return await dispatch(name, rest, {
      dir: requireStateDir(loaded),
      history: loaded.config.scheduledPrompts?.history ?? DEFAULT_PROMPT_HISTORY,
      owners: [...new Set(loaded.config.scopes.map((scope) => scope.owner))],
      run: io.runProcess,
      now: () => timestamp(io.now()),
      print: (value) => {
        io.stdout(`${dumps(value)}\n`)
      },
      write: io.stdout,
    })
  } catch (error) {
    if (isUsageError(error)) {
      io.stderr(`supervisor state: ${(error as Error).message}\n${STATE_HELP}`)
      return 2
    }
    io.stderr(`${(error as Error).message}\n`)
    return error instanceof StoppedError ? STOPPED_EXIT : 1
  }
}
