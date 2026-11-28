import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadClassifierDef, type ClassifierOutput } from '../policy/classifier-def.js'
import { buildClassifierInput } from '../policy/classifier-input.js'
import { findClassifiers, usesCodeReview } from '../policy/classify-find.js'
import { readDiff, readHead } from '../policy/classify-gh.js'
import { loadPolicySet } from '../policy/run-check.js'
import { FactsError, PULL_NUMBER, REPOSITORY } from '../policy/facts-gh.js'
import { collectClassifiers } from './policy-classify-collect.js'
import { resolveCliPolicy } from './policy-resolve.js'
import type { CliIo } from './run.js'

/** What `classify-prepare` wrote for one classifier, or why it wrote nothing. */
export type ManifestEntry =
  | {
      name: string
      input: string
      answer: string
      model: string
      outputs: Record<string, ClassifierOutput>
    }
  | { name: string; error: string }

export interface Manifest {
  pull: { repository: string; number: number; head: string }
  classifiers: ManifestEntry[]
  /** Set when at least one loaded policy names `claude/code_review`. */
  codeReview?: true
}

export interface ClassifyArgs {
  positionals: string[]
  supervisorPolicy: boolean
  out: string
  values: Map<string, string>
}

const VALUE_OPTIONS = new Set(['--dir', '--repo-dir', '--out', '--reviewer'])

/** The parsed arguments, or the usage error to print. */
function parseArgs(args: string[]): ClassifyArgs | string {
  const values = new Map<string, string>()
  const positionals: string[] = []
  let supervisorPolicy = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (VALUE_OPTIONS.has(arg) && i + 1 < args.length) values.set(arg, args[++i]!)
    else if (arg === '--supervisor-policy') supervisorPolicy = true
    else if (!arg.startsWith('-')) positionals.push(arg)
    else return `Unknown or incomplete option: ${arg}`
  }
  const out = values.get('--out')
  if (!out) return '--out is required.'
  return { positionals, supervisorPolicy, out: resolve(out), values }
}

async function prepare(args: ClassifyArgs, io: CliIo): Promise<number | string> {
  if (args.values.has('--reviewer')) return '--reviewer is only valid with classify-collect.'
  const [repository, number, ...extra] = args.positionals
  if (repository === undefined || number === undefined || extra.length > 0) {
    return 'Expected <owner>/<repo> <pr>.'
  }
  if (!REPOSITORY.test(repository)) return `'${repository}' must look like <owner>/<repo>.`
  if (!PULL_NUMBER.test(number)) return `'${number}' must be a pull request number.`
  // The directory is the one policy check resolves: the flags, else the supervisor config.
  const source = await resolveCliPolicy(io.env, process.cwd(), repository, {
    dir: args.values.get('--dir'),
    repoDir: args.values.get('--repo-dir'),
    supervisorPolicy: args.supervisorPolicy,
  })
  const { dir, repoDir } = source
  const policies = await loadPolicySet(source, io.env, process.cwd())
  const found = findClassifiers(policies, (p) => (p.supervisorRoot || !repoDir ? dir : repoDir))
  const codeReview = usesCodeReview(policies)

  const pr = Number(number)
  const head = await readHead(io.runProcess, repository, pr)
  const diff = found.length > 0 ? await readDiff(io.runProcess, repository, pr) : ''
  if ((await readHead(io.runProcess, repository, pr)) !== head) {
    throw new FactsError(`${repository}#${pr} got a new head while its diff was read`)
  }
  await mkdir(args.out, { recursive: true })
  const classifiers: ManifestEntry[] = []
  for (const { name, classifiers: where, error } of found) {
    let entry: ManifestEntry
    try {
      if (error) throw new Error(error)
      const def = await loadClassifierDef(where, name)
      const input = join(args.out, `${name}.md`)
      const answer = join(args.out, `${name}.answer.json`)
      await writeFile(input, buildClassifierInput(name, def, diff))
      await rm(answer, { force: true })
      entry = { name, input, answer, model: def.model, outputs: def.outputs }
    } catch (err) {
      entry = { name, error: (err as Error).message }
    }
    classifiers.push(entry)
  }
  const manifest: Manifest = {
    pull: { repository, number: pr, head },
    classifiers,
    ...(codeReview ? { codeReview: true } : {}),
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(args.out, 'manifest.json'), text)
  io.stdout(text)
  return 0
}

export async function runClassify(
  command: 'prepare' | 'collect',
  argv: string[],
  io: CliIo,
  help: string,
): Promise<number> {
  const args = parseArgs(argv)
  try {
    const result =
      typeof args === 'string'
        ? args
        : await (command === 'prepare' ? prepare : collectClassifiers)(args, io)
    if (typeof result === 'number') return result
    io.stderr(`${result}\n${help}`)
    return 2
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`)
    return 2
  }
}
