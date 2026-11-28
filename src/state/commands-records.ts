import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { need, REPOSITORY, TEXT, UsageError, type StateContext } from './context.js'
import { dumpsIndented, get, isObject, put, type Json, type JsonObject } from './json.js'
import {
  arrayField,
  expectArray,
  expectObject,
  loadState,
  objectField,
  parseJson,
  saveState,
  StateError,
} from './store.js'

export async function route(args: string[], ctx: StateContext): Promise<void> {
  const options = { what: TEXT, to: TEXT, evidence: TEXT, issue: TEXT, note: TEXT }
  const { values } = parseArgs({ args, options })
  const entry: JsonObject = {
    what: need(values.what, 'what'),
    to: need(values.to, 'to'),
    at: ctx.now(),
  }
  for (const key of ['evidence', 'issue', 'note'] as const) {
    if (values[key]) {
      entry[key] = values[key]
    }
  }
  const state = await loadState(ctx.dir)
  arrayField(state, 'routed').push(entry)
  await saveState(ctx.dir, state)
  ctx.print(entry)
}

export async function annotateRoute(args: string[], ctx: StateContext): Promise<void> {
  const { values } = parseArgs({ args, options: { match: TEXT, note: TEXT, issue: TEXT } })
  const match = need(values.match, 'match')
  const note = need(values.note, 'note')
  const state = await loadState(ctx.dir)
  const routed = expectArray(get(state, 'routed') ?? [], 'routed')
  const hits = routed.filter(
    (entry): entry is JsonObject =>
      isObject(entry) && typeof entry.what === 'string' && entry.what.includes(match),
  )
  const hit = hits[0]
  if (hit === undefined || hits.length !== 1) {
    throw new StateError(`annotate-route: ${hits.length} entries match '${match}'; need exactly 1`)
  }
  hit.note = note
  if (values.issue) {
    hit.issue = values.issue
  }
  await saveState(ctx.dir, state)
  ctx.print(hit)
}

export async function sweepDone(args: string[], ctx: StateContext): Promise<void> {
  parseArgs({ args, options: {} })
  const state = await loadState(ctx.dir)
  const lastSweepAt = ctx.now()
  state.lastSweepAt = lastSweepAt
  delete state.sweep
  await saveState(ctx.dir, state)
  ctx.print({ lastSweepAt })
}

function commentId(value: Json): number {
  const id = Math.trunc(Number(isObject(value) ? value.id : value))
  if (value === null || !Number.isFinite(id)) {
    throw new StateError(`reviewed: ${JSON.stringify(value)} is not a comment id`)
  }
  return id
}

/** `Date` rolls 2026-02-30 over to March; a time must name a day that exists. */
function realCalendarDate(text: string): boolean {
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? []
  if (year === undefined) {
    return false
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.toISOString().slice(0, 10) === `${year}-${month}-${day}`
}

/** Drop entries harvested before `cutoff`; an entry with no readable `harvestedAt` is kept. */
function pruneBefore(comments: JsonObject, text: string): void {
  const cutoff = Date.parse(text)
  if (Number.isNaN(cutoff) || !realCalendarDate(text)) {
    throw new StateError(`reviewed: --prune-before '${text}' is not a time`)
  }
  for (const [repository, ids] of Object.entries(comments)) {
    const kept = expectArray(ids, `reviewedComments.${repository}`).filter(
      (entry) =>
        !isObject(entry) ||
        typeof entry.harvestedAt !== 'string' ||
        !(Date.parse(entry.harvestedAt) < cutoff),
    )
    put(comments, repository, kept)
  }
}

/**
 * Add harvested comment ids from a `{"<owner>/<repo>": [ids]}` file, skipping known ones, and/or
 * drop entries harvested before `--prune-before`, in one locked read-modify-write.
 */
export async function reviewed(args: string[], ctx: StateContext): Promise<void> {
  const { values } = parseArgs({ args, options: { file: TEXT, 'prune-before': TEXT } })
  if (values.file === undefined && values['prune-before'] === undefined) {
    throw new UsageError('reviewed: give --file, --prune-before, or both')
  }
  const state = await loadState(ctx.dir)
  const comments = objectField(state, 'reviewedComments')
  if (values.file !== undefined) {
    const added = expectObject(
      parseJson(await readFile(values.file, 'utf8'), values.file),
      'reviewed --file',
    )
    for (const [repository, ids] of Object.entries(added)) {
      if (!REPOSITORY.test(repository)) {
        throw new StateError(`reviewed: '${repository}' must look like owner/repo`)
      }
      const current = arrayField(comments, repository, `reviewedComments.${repository}`)
      const have = new Set(current.map(commentId))
      for (const id of expectArray(ids, `reviewed --file ${repository}`).map(commentId)) {
        if (!have.has(id)) {
          current.push({ id, harvestedAt: ctx.now() })
          have.add(id)
        }
      }
    }
  }
  if (values['prune-before'] !== undefined) {
    pruneBefore(comments, values['prune-before'])
  }
  await saveState(ctx.dir, state)
  const counts: JsonObject = {}
  for (const [repository, ids] of Object.entries(comments)) {
    put(counts, repository, expectArray(ids, `reviewedComments.${repository}`).length)
  }
  ctx.print(counts)
}

export async function show(args: string[], ctx: StateContext): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true })
  if (positionals.length > 1) {
    throw new UsageError(`unexpected arguments: ${positionals.slice(1).join(' ')}`)
  }
  const state = await loadState(ctx.dir)
  const key = positionals[0]
  const value = key === undefined ? Object.keys(state).sort() : (get(state, key) ?? null)
  ctx.write(`${dumpsIndented(value)}\n`)
}
