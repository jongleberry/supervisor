import { parseArgs } from 'node:util'
import { need, TEXT, UsageError, type StateContext } from './context.js'
import { isObject, type Json, type JsonObject } from './json.js'
import { arrayField, loadState, objectField, saveState } from './store.js'

function parseLap(raw: string): number {
  const lap = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(lap)) {
    throw new UsageError(`--lap must be a positive integer, got '${raw}'`)
  }
  return lap
}

/**
 * Drop pre-lap run objects from earlier state files so the first `sp-record` or `sp-next` write
 * after upgrading fits `schemas/state.json`. Entries that carry `lap` (even an invalid one) or are
 * not objects are left intact so the schema rejects them.
 */
function dropLegacyRuns(runs: Json[]): Json[] {
  return runs.filter((run) => !(isObject(run) && !Object.hasOwn(run, 'lap')))
}

export async function scheduledPromptRecord(args: string[], ctx: StateContext): Promise<void> {
  const options = { prompt: TEXT, 'run-id': TEXT, outcome: TEXT, lap: TEXT, next: TEXT, pr: TEXT }
  const { values } = parseArgs({ args, options })
  const entry: JsonObject = {
    prompt: need(values.prompt, 'prompt'),
    runId: need(values['run-id'], 'run-id'),
    at: ctx.now(),
    outcome: need(values.outcome, 'outcome'),
    lap: parseLap(need(values.lap, 'lap')),
  }
  const next = need(values.next, 'next')
  if (values.pr) {
    entry.pr = values.pr
  }
  const state = await loadState(ctx.dir)
  const prompts = objectField(state, 'scheduledPrompts')
  const runs = dropLegacyRuns(arrayField(prompts, 'runs', 'scheduledPrompts.runs'))
  runs.push(entry)
  prompts.runs = runs.slice(-ctx.history)
  prompts.next = next
  await saveState(ctx.dir, state)
  ctx.print({ recorded: entry, next })
}

export async function scheduledPromptNext(args: string[], ctx: StateContext): Promise<void> {
  const { values } = parseArgs({ args, options: { next: TEXT } })
  const next = need(values.next, 'next')
  const state = await loadState(ctx.dir)
  const prompts = objectField(state, 'scheduledPrompts')
  if (Array.isArray(prompts.runs)) {
    prompts.runs = dropLegacyRuns(prompts.runs)
  }
  prompts.next = next
  await saveState(ctx.dir, state)
  ctx.print({ next })
}
