import { discoverPolicies, selectRulesForFile } from '../policy/discover.js'
import { loadLayeredPolicies } from '../policy/layers.js'
import type { PolicyFile } from '../policy/types.js'
import { runCheck } from './policy-check.js'
import { runClassify } from './policy-classify.js'
import { requiredAlwaysHumanFromConfig } from '../config/policy.js'
import { formatPoliciesOverview, formatRuleSummary } from './policy-format.js'
import type { CliIo } from './run.js'

const POLICY_HELP = `Usage:
  supervisor policy explain <dir> [path] [--repo-dir <checkout>]
  supervisor policy check <owner>/<repo> <pr> [--dir <dir>] [--supervisor-policy] [--json]
                          [--classifiers <json>] [--print-input] [--repo-dir <checkout>]
  supervisor policy check [--dir <dir>] --input <json> [--supervisor-policy] [--json]
                          [--repo-dir <checkout>]
  supervisor policy classify-prepare <owner>/<repo> <pr> [--dir <dir>] --out <out dir>
                          [--supervisor-policy] [--repo-dir <checkout>]
  supervisor policy classify-collect --out <out dir> [--reviewer <account>]

classify-prepare reads the pull request's head and diff with \`gh api\`, finds the repo/<name>
classifiers the policies in <dir> name (--dir resolves as for check), and writes for each one input file <out dir>/<name>.md
(its question and the diff, nothing else about the pull request) and the path its answer goes to.
It prints <out dir>/manifest.json, and sets codeReview: true when any policy names
claude/code_review. A classifier whose definition cannot be loaded is listed with its error and gets
no input file. A diff too large for GitHub to return whole fails the command.
An agent answers each input file with one JSON object, {"<output>": <value>, ...}, written to
the answer path. classify-collect checks each answer against the outputs the definition allows,
maps the newest final review of the head by --reviewer (or finalReview.reviewer in config) to
claude/code_review when codeReview is set, writes the valid results to <out dir>/classifiers.json
for check --classifiers, and prints its path. An answer or final review that is missing, untrusted
or not allowed is left out, with the reason on stderr. It exits 1, writing nothing, when the pull
request has a new head since classify-prepare.

check <owner>/<repo> <pr> reads the pull request from GitHub with \`gh api\`: its current head,
changed files, authors, labels and approvals of that head. It evaluates the policies in <dir>,
then asks pr-shepherd (read-only: it changes nothing on GitHub) whether it would merge that
head. The next step is merge only when the policy allows it and pr-shepherd says the head is
ready. When the policy allows the merge but pr-shepherd does not, the next step is shepherd:
run pr-shepherd on the pull request. A pending check needs no person. When the verdict approves
and every unmet seat names only bots, the next step is request_review: request a final review of
the head. An unmet seat a person or team can fill, a verdict that does not approve, and a blocker,
such as a draft or a closed pull request, escalate.

When --dir is omitted, check and classify-prepare resolve the policy from the supervisor configuration
($SUPERVISOR_CONFIG, else .supervisor.json in the current directory): mergeAuthority.policy
resolved against the config file's real path (as the supervisor policy), and—unless --repo-dir is
passed—<checkoutRoot>/<repo> from the matching scope when that directory exists. Passing --dir
explicitly skips resolving the policy directory and checkout from the config (no implicit
layering); the config's mergeAuthority.requiredAlwaysHuman floor still applies when
--supervisor-policy or --repo-dir is given, and explicit values always win.

pr-shepherd reads its .pr-shepherdrc.yml from the target repository's checkout (--repo-dir, else
the configured checkout when --dir was omitted, else the current directory).

  --dir <dir>           Policy directory (default: mergeAuthority.policy from config). Passing it
                        explicitly skips resolving the policy directory and checkout from config.
  --classifiers <json>  Classifier results to evaluate with: {"<name>": {"status": ...}}.
                        Without it no classifier has a result.
  --print-input         Print the collected input as JSON and do not evaluate.
  --input <json>        Evaluate a written input file instead of a pull request.
  --repo-dir <checkout> Treat the policy directory as the supervisor policy and add the
                        repository's own .supervisor/approvals.yml files from a default-branch
                        checkout. Also the directory pr-shepherd reads its config from (default
                        when --dir is omitted: <checkoutRoot>/<repo> from config when present,
                        else current directory).

Exit codes: 0 the next step is merge (or --print-input printed the input), 1 it is not,
2 the pull request, the policies or the input could not be read.
`

async function runExplain(args: string[], io: CliIo): Promise<number> {
  const flag = args.indexOf('--repo-dir')
  const repoDir = flag === -1 ? undefined : args.splice(flag, 2)[1]
  if (args.length < 1 || args.length > 2 || (flag !== -1 && !repoDir)) {
    io.stderr(POLICY_HELP)
    return 2
  }
  const [dir, targetPath] = args as [string, string | undefined]
  let policies: PolicyFile[]
  try {
    policies = repoDir
      ? await loadLayeredPolicies(dir, repoDir, {
          requiredAlwaysHuman: await requiredAlwaysHumanFromConfig(io.env, process.cwd()),
        })
      : await discoverPolicies(dir)
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`)
    return 2
  }
  if (!targetPath) {
    io.stdout(formatPoliciesOverview(policies))
    return 0
  }
  const { decidingPolicy, rules } = selectRulesForFile(policies, targetPath)
  if (!decidingPolicy || rules.length === 0) {
    io.stdout(`Path: ${targetPath}\nUncovered (no enforcing policy rule matches).\n`)
    return 0
  }
  const lines = [`Path: ${targetPath}`, `Deciding policy: ${decidingPolicy.path}`]
  for (const rule of rules) {
    lines.push(formatRuleSummary(rule))
  }
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

export async function runPolicyCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand === 'explain') return await runExplain(rest, io)
  if (subcommand === 'check') return await runCheck(rest, io, POLICY_HELP)
  if (subcommand === 'classify-prepare') return await runClassify('prepare', rest, io, POLICY_HELP)
  if (subcommand === 'classify-collect') return await runClassify('collect', rest, io, POLICY_HELP)
  io.stderr(`Unknown policy subcommand: ${subcommand ?? '(none)'}\n${POLICY_HELP}`)
  return 2
}
