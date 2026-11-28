import { readFile } from 'node:fs/promises'
import { evaluatePolicies } from '../policy/evaluate.js'
import { FactsError, PULL_NUMBER, REPOSITORY } from '../policy/facts-gh.js'
import type { PullFacts } from '../policy/facts.js'
import { checkPull, type PullCheckResult } from '../policy/pull-check.js'
import {
  collectPullCheckFacts,
  loadPolicySet,
  parseClassifiersData,
  runPullCheck,
  type ClassifiersInput,
  type PullCheckDeps,
  type PullCheckRequest,
} from '../policy/run-check.js'
import type { EvaluationInput } from '../policy/types.js'
import { isObject } from '../state/json.js'
import { resolveCliPolicy } from './policy-resolve.js'
import { formatHumanCheck, formatPullCheck } from './policy-format.js'
import type { CliIo } from './run.js'

interface CheckArgs {
  positionals: string[]
  dir?: string
  input?: string
  classifiers?: string
  repoDir?: string
  json: boolean
  supervisorPolicy: boolean
  printInput: boolean
}

const VALUE_OPTIONS: Record<string, 'dir' | 'input' | 'classifiers' | 'repoDir'> = {
  '--dir': 'dir',
  '--input': 'input',
  '--classifiers': 'classifiers',
  '--repo-dir': 'repoDir',
}
const FLAGS: Record<string, 'json' | 'supervisorPolicy' | 'printInput'> = {
  '--json': 'json',
  '--supervisor-policy': 'supervisorPolicy',
  '--print-input': 'printInput',
}

/** The parsed arguments, or the usage error to print. */
function parseArgs(args: string[]): CheckArgs | string {
  const parsed: CheckArgs = {
    positionals: [],
    json: false,
    supervisorPolicy: false,
    printInput: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    const value = Object.hasOwn(VALUE_OPTIONS, arg) ? VALUE_OPTIONS[arg] : undefined
    const flag = Object.hasOwn(FLAGS, arg) ? FLAGS[arg] : undefined
    if (value && i + 1 < args.length) parsed[value] = args[++i]!
    else if (flag) parsed[flag] = true
    else if (!arg.startsWith('-')) parsed.positionals.push(arg)
    else return `Unknown or incomplete option: ${arg}`
  }
  const [repository, number, ...extra] = parsed.positionals
  if (repository === undefined) {
    if (!parsed.input) return 'Expected <owner>/<repo> <pr>, or --input <json>.'
    if (parsed.classifiers || parsed.printInput) {
      return '--classifiers and --print-input need <owner>/<repo> <pr>.'
    }
    return parsed
  }
  if (number === undefined || extra.length > 0) return 'Expected <owner>/<repo> <pr>.'
  if (!REPOSITORY.test(repository)) return `'${repository}' must look like <owner>/<repo>.`
  if (!PULL_NUMBER.test(number)) return `'${number}' must be a pull request number.`
  if (parsed.input) return '--input cannot be combined with <owner>/<repo> <pr>.'
  return parsed
}

async function readJson(path: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (err) {
    throw new FactsError(`Cannot read ${what} JSON: ${(err as Error).message}`, { cause: err })
  }
}

const COLLECTED_KEYS = ['pull', 'readiness', 'blockers'] as const

/**
 * A written input, or one that --print-input printed. A printed one carries the head, whether
 * pr-shepherd would merge it, and the blockers; they must hold a merge on replay as they do
 * live, so it needs all three. An input from before pr-shepherd, with `checks`, is refused.
 */
async function readInput(path: string): Promise<EvaluationInput | PullFacts> {
  const raw = await readJson(path, 'input')
  if (!isObject(raw) || !Array.isArray(raw.changedFiles)) {
    throw new FactsError('Input JSON must be an object with a changedFiles array')
  }
  if ('checks' in raw) {
    throw new FactsError(
      'This input has the old checks key: print it again with --print-input, which now carries readiness',
    )
  }
  if (COLLECTED_KEYS.some((key) => key in raw)) {
    const whole = isObject(raw.pull) && isObject(raw.readiness) && Array.isArray(raw.blockers)
    if (!whole) throw new FactsError('A printed input needs pull, readiness and blockers together')
    if (typeof (raw.readiness as { ready?: unknown }).ready !== 'boolean') {
      throw new FactsError('A printed input needs readiness.ready as true or false')
    }
  }
  return raw as unknown as EvaluationInput | PullFacts
}

async function readClassifiers(path: string): Promise<ClassifiersInput> {
  return parseClassifiersData(await readJson(path, 'classifiers'))
}

function inputRepository(input: EvaluationInput | PullFacts): string | undefined {
  const candidate = input.facts?.repository
  return typeof candidate === 'string' && REPOSITORY.test(candidate) ? candidate : undefined
}

async function checkPullRequest(args: CheckArgs, io: CliIo): Promise<number> {
  const [repository, number] = args.positionals as [string, string]
  const classifiers = args.classifiers ? await readClassifiers(args.classifiers) : undefined
  const deps: PullCheckDeps = {
    env: io.env,
    cwd: process.cwd(),
    runProcess: io.runProcess,
    shepherdStatus: io.shepherdStatus,
  }
  const source = await resolveCliPolicy(deps.env, deps.cwd, repository, args)
  const request: PullCheckRequest = {
    repository,
    pr: Number(number),
    ...source,
    ...(classifiers ? { classifiers } : {}),
  }
  if (args.printInput) {
    const { facts } = await collectPullCheckFacts(request, deps)
    io.stdout(`${JSON.stringify(facts, null, 2)}\n`)
    return 0
  }
  const result = await runPullCheck(request, deps)
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatPullCheck(result))
  return result.nextStep.action === 'merge' ? 0 : 1
}

export async function runCheck(argv: string[], io: CliIo, help: string): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    io.stderr(`${args}\n${help}`)
    return 2
  }
  try {
    if (args.positionals.length > 0) return await checkPullRequest(args, io)
    const input = await readInput(args.input!)
    const cwd = process.cwd()
    const source = await resolveCliPolicy(io.env, cwd, inputRepository(input), args)
    const policies = await loadPolicySet(source, io.env, cwd)
    const collected = 'blockers' in input
    const result = collected ? checkPull(policies, input) : evaluatePolicies(policies, input)
    const text = collected ? formatPullCheck(result as PullCheckResult) : formatHumanCheck(result)
    io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : text)
    return result.nextStep.action === 'merge' ? 0 : 1
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`)
    return 2
  }
}
