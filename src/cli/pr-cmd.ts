import { parseArgs } from 'node:util'
import { REPOSITORY } from '../policy/facts-gh.js'
import { listProvenancePulls } from '../pr/list.js'
import { FLAG, UsageError } from '../state/context.js'
import { dumps } from '../state/json.js'
import type { CliIo } from './run.js'

const PR_HELP = `Usage: supervisor pr list <owner>/<repo> [--json]

Lists open pull requests in <owner>/<repo> that carry a supervisor provenance comment
(a comment whose body begins with "<!-- supervisor:provenance v1 -->"). Paginates both
pull requests and comments through the GitHub GraphQL API.

Output is one line per pull request ("<owner>/<repo>#<N>  <title>", with "[draft] " for
drafts) sorted by pull request number, or one JSON array with --json.

Options:
  --json       Print a JSON array of {repository, number, title, url, isDraft} objects
  -h, --help   Show help
`

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

async function runList(args: string[], io: CliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(PR_HELP)
    return 0
  }
  let json: boolean
  let repository: string
  try {
    const parsed = parseArgs({
      args,
      options: { json: FLAG },
      allowPositionals: true,
    })
    json = parsed.values.json === true
    if (parsed.positionals.length !== 1) {
      throw new UsageError('expected exactly one <owner>/<repo> argument')
    }
    repository = parsed.positionals[0]!
    if (!REPOSITORY.test(repository)) {
      throw new UsageError(`'${repository}' must look like owner/repo`)
    }
  } catch (error) {
    io.stderr(`supervisor pr list: ${(error as Error).message}\n${PR_HELP}`)
    return 2
  }
  try {
    const pulls = await listProvenancePulls(io.runProcess, repository)
    if (json) {
      io.stdout(`${dumps(pulls.map((pull) => ({ ...pull })))}\n`)
    } else {
      for (const pull of pulls) {
        const prefix = pull.isDraft ? '[draft] ' : ''
        io.stdout(`${pull.repository}#${pull.number}  ${prefix}${singleLine(pull.title)}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`supervisor pr list: ${(error as Error).message}\n`)
    return 1
  }
}

/** `supervisor pr`: pull-request selection commands for sweeps and triage. */
export async function runPrCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand === '--help' || subcommand === '-h') {
    io.stdout(PR_HELP)
    return 0
  }
  if (subcommand === 'list') {
    return await runList(rest, io)
  }
  io.stderr(`Unknown pr subcommand: ${subcommand ?? '(none)'}\n${PR_HELP}`)
  return 2
}
