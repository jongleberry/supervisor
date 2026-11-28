# Merge policy

What may merge without a person is written in the format of Claude Approvals' `approvals.yml` (`version: 1`), the format Claude Code's `/ship` uses. The supervisor evaluates it itself. So any harness can run the evaluator, and a repository can switch to the Claude Approvals product later without rewriting its rules.

[Back to the graph](graph.md)

## Two places a policy can live

| File                         | Where                                         | Role                                                         |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Supervisor policy            | A private file, named in the config           | The root. Its rules apply in every repository of every scope |
| Repository policy (optional) | `.supervisor/approvals.yml` in the repository | Below the root, like a directory's policy file in the format |

They combine the way the format combines a root file and a directory's file. Where a repository has its own file, that file decides. Of the supervisor's rules, only those marked `nested: inherit` still hold there. So the always-human rules and the final-review seat are inherited rules. A repository file can add its own carve-outs or ask for more, and cannot remove them.

**No label grants merge authority.** The policy alone decides what may merge. A label such as `automation` only marks a PR as opened by an agent, for the triage queue. A rule may still read `pr/labels` as a condition, for example to hold a PR for a person.

A PR that changes a policy file is judged by the default branch's copy, and an inherited rule sends every change to a policy file to a person.

### How the two are loaded

- **The supervisor policy** is `.claude/approvals.yml` in a directory outside every repository. A directory-level policy file beside it is refused when a repository is loaded with it, because its paths would belong to no repository.
- **A repository policy** is `.supervisor/approvals.yml` at the root of the checkout. A directory below can hold its own `.supervisor/approvals.yml`, which decides for that directory the way a directory's `.claude/approvals.yml` does in the format. `approvals.yaml` is read too, and a folder with both names is refused.
- **Nearest file first.** Going up from a changed file, the first enforcing file with a matching rule that has a `verdict` decides. Where no repository rule matches a file, the supervisor policy decides for it. A repository file in `mode: observe` decides nothing.
- **Locals are inherited.** A repository file can use the supervisor policy's locals, such as a `"@reviewed"` seat, and its own locals of the same name replace them in that file only. A file that depends on an inherited local needs that local copied in before it moves to `.claude/`.
- **The loader reads what is on disk.** `loadLayeredPolicies(supervisorDir, repoDir)` and `--repo-dir` take a checkout, so the caller must pass a checkout of the default branch, never of the PR's head. Otherwise a PR could loosen the rules that judge it.
- **A changed policy file needs a rule that approves it.** `.supervisor/approvals.yml`, `.claude/approvals.yml` and `.claude/classifiers/**`, at any depth, merge only where a rule with `claude: approves` covers them.

### Protected files

These files are protected, as Claude Approvals protects them:

- policy files (`approvals.yml` or `approvals.yaml` in `.supervisor/` or `.claude/`), at any depth
- classifier definitions (`.claude/classifiers/**`), at any depth
- `.gitattributes` and `.gitmodules`, at any depth
- `REVIEW.md` at the root

The product also protects symlinks and submodules. The supervisor does not, because it reads changed paths and a path does not say which file is one.

Where no rule applies to a changed protected file, because none matches it or every matching rule's `if` is false, the evaluator applies a baseline instead of leaving the file with no verdict:

- the verdict is `comments`, so the supervisor never merges the PR, whatever its other files' rules say
- one seat is asked: a person other than the PR's author and opener. No bot fills it, the final reviewer included
- the next step is to escalate, and its reason names the file

The baseline covers a gap in a policy. It does not replace the inherited rule on policy files: where a rule does apply to a protected file, that rule decides, so a rule with `claude: approves` can still let one merge.

## Staying compatible with Claude Approvals

- **Repository policies use only the product's vocabulary.** The product refuses a whole file for one unknown key, so the supervisor's loader checks each repository policy against that vocabulary. A repository policy that reads `pr/repository` or `pr/labels` does not load, and the error names the file and the rule.
- **Judgment carve-outs are `repo/<name>` classifiers,** defined in `.claude/classifiers/<name>/` in the product's layout (`def.yml` and `prompt.md`). The supervisor runs them with its own model; the product would run the same definitions, billed. A classifier several repositories share, such as the flake-fix one, lives beside the supervisor policy and is copied into a repository that adopts the product.
- **The folder is the switch.** `.supervisor/approvals.yml` is inert for the product. Moving it to `.claude/approvals.yml` hands that repository to Claude Approvals, and its billed reviews start.
- **The config says which evaluation to trust.** `mergeAuthority.policyEngine` is `supervisor` for the supervisor's own evaluation, or `claude-approvals` for the product's green check. Under `claude-approvals` the supervisor still does the merge, since the product only approves.
- **A trial without risk.** With `policyEngine: "compare"` the supervisor evaluates as usual, also reads the product's check, and reports any disagreement. The product's rules can run in `mode: observe` meanwhile, so nothing depends on its verdict.

## How the supervisor reads the format

| Key                    | In Claude Approvals     | In the supervisor                                                                                                       |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `claude: approves`     | Claude may approve      | The supervisor may merge once the seats are filled                                                                      |
| `claude: comments`     | Claude does not approve | The supervisor does not merge; the PR goes to a person                                                                  |
| `claude: blocks`       | Nothing merges          | Nothing merges                                                                                                          |
| `seats`                | Who must approve        | The same. A bot fills a seat only where a set names it, so `bot:<review app>` is how a rule requires the final reviewer |
| `pr/*`, `rule/*` facts | As documented           | The same, computed from the GitHub API                                                                                  |
| `repo/<name>`          | Custom classifiers      | The same definitions, run by the supervisor's model                                                                     |
| `claude/code_review`   | Anthropic's Code Review | Mapped to a review request to [code-reviewer](https://github.com/jonathanong/code-reviewer) at the matching depth       |

**Extensions, in the supervisor policy only.** A repository policy cannot use them, because the product would refuse the file.

| Extension                                                                       | Why the format needs it                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Fact `pr/repository`, matched like `pr/base`: `"pr/repository = ['<owner>/*']"` | The supervisor policy covers many repositories; the format assumes one |
| Fact `pr/labels`, with `ANY` and `ALL` as for `pr/authors`                      | Flake-fix and review-request labels                                    |

A carve-out names the repositories it applies to with `pr/repository`. A scope that no override names stays at `claude: comments` everywhere, so the supervisor merges nothing there, which is what a scope in `report` mode needs. A scope may skip the final reviewer by writing `seats: 0` in its overrides; the supervisor loads that as written.

**Outside the policy:**

- **CI and merge readiness:** the supervisor reads no check and no merge state itself. It asks [pr-shepherd](https://github.com/jongleberry/pr-shepherd), through its read-only `status` call, whether it would merge the head, and holds the merge unless the answer is `merge`. pr-shepherd knows the checks the repository requires, the reviews and the branch rules.
- **Host, model and attended session:** these decide who may merge at all, not what a PR needs, so they live in the [config](config.md).
- **Decisions:** the policy covers the merge step. It grants nothing about architecture or trade-offs, which stay with a person.

**Model calls.** Facts come from the GitHub API. `repo/<name>` classifiers are the evaluator's only model calls, made through whichever harness runs the supervisor. So any harness can run `supervisor policy check`.

**Running a `repo/<name>` classifier** is the [supervisor-classify](../skills/supervisor-classify/SKILL.md) skill, built to give the narrowest answer it can. `supervisor policy classify-prepare` resolves the policy directory as `policy check` does (`--dir`, else the supervisor config, else an error that says to pass `--dir`), finds the classifiers the policies name, loads each definition from `.claude/classifiers/<name>/` beside the policy file that names it, and writes one input file per classifier: its question and the PR's diff, marked as data, and nothing else. The skill has a fresh `supervisor-classifier` subagent answer each input. That agent can only read the one file, sees no other classifier, and is not told about the PR, the policy or the merge. `supervisor policy classify-collect` checks each answer against the outputs and values the definition allows and writes the valid ones for `--classifiers`. An answer that is missing or not allowed is no result, so the rule's stricter verdict holds. It refuses everything when the PR has a new head, and it writes the pull request and head into the file as `pull`. `policy check` refuses a file whose `pull` is not the head it read, so a result never carries over to a later head. A file written by hand has no `pull` and is not checked this way. A definition may set `version`, `description`, `model`, `prompt` (or a `prompt.md`) and `outputs` (`criteria` and `ordinal` with `values`, `numeric` with integer `min` and `max`). A definition that sets `inputs`, `tools` or `budget`, a call that passes inputs, or a versioned call (`repo/<name>@<N>`) has no result, and the manifest lists it with the reason.

**Mapping a final review to `claude/code_review`.** When any loaded policy names `claude/code_review`, `classify-prepare` marks `codeReview: true` in `manifest.json` (without reading the diff when there are no `repo/<name>` classifiers). `classify-collect` then reads the pull request's reviews from GitHub and maps the newest submitted final review of that head from the trusted reviewer (`--reviewer <account>`, or `finalReview.reviewer` in config) to `claude/code_review` in `classifiers.json`. Only reviews by that account carrying a `<!-- final-review sha=<head> verdict=<V> effort=<E> -->` marker (whose `commit_id` and marker `sha` both match the head, and whose latest review was neither dismissed nor skipped) count; without a trusted reviewer or a matching review, or when the latest final review is skipped or malformed, `claude/code_review` is omitted so the policy fails closed:

- **Effort -> `level`:** `low` -> `quick`, `medium` -> `standard`, `high` -> `deep`.
- **Verdict -> `value`:** `Approve` -> `pass`; `Comment` or `Request-Changes` -> `fail`. `Skipped` produces no result (a skipped review never inspected the head, so a rule requiring `claude/code_review` stays unmet).
- **Findings -> `severity`:** `no findings` -> `none`; highest finding severity from the `Reviewed` summary line (`low` -> `low`, `medium` -> `medium`, `high` -> `high`, `blocking` -> `critical`). If the summary line is missing or cannot be parsed, `severity` is left out so severity conditions stay undecided.

## The author trap

Agents push under a person's login, so that person is the author of the agents' PRs. The author fills a seat without approving. So a bare `seats: 1` is met by the agent's own PR, with nobody looking. A rule that means "reviewed" names the reviewer: `[{ count: 1, from: "bot:<review app>" }]`. The evaluator flags any rule whose seats the author alone can fill.

An always-human rule says `claude: comments`, so the supervisor never merges what it matches and a person does. Always-human rules are inherited: a repository policy can add to them, and the supervisor refuses a policy that lacks the always-human rules the config requires. By default it requires none.

### The always-human rules a supervisor policy must have

Loading the supervisor policy fails unless its root file sends each required path to a person. The required paths come from `mergeAuthority.requiredAlwaysHuman` in the config. The list is empty by default, so nothing is required and any policy loads. A policy directory with no root `.claude/approvals.yml` is still refused. The error names the file, the class of path, and the sample paths no rule matched. A rule counts as always-human only when all of these hold:

- it is marked `nested: inherit`, on the rule or at the top of the file, so it still holds below a repository's own file
- it is enforced, not in `mode: observe`
- it has no `if`, so it applies to every PR
- its verdict, alone and under each override, is `claude: blocks`, or `claude: comments` with at least one seat that only a person can fill (a verdict with no seats, or only a bot's, asks nobody)

Each requirement is a name and sample paths, because two globs cannot be compared but a glob can be tested against a path. `EXAMPLE_ALWAYS_HUMAN` in `src/policy/always-human.ts` is an example list. The eval and the tests pass it. An installation might require something like this:

| Required                | Sample paths a rule must match                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| CI workflow definitions | `.github/workflows/ci.yml`                                                                                    |
| Release paths           | `release/publish.sh`                                                                                          |
| Signing paths           | `signing/sign.sh`                                                                                             |
| Policy files            | `approvals.yml` and `approvals.yaml` in `.supervisor/` and `.claude/`, at the root and in `packages/example/` |
| Classifier definitions  | `.claude/classifiers/example/def.yml` and `prompt.md`, at the root and in `packages/example/`                 |

Write the list in the config as `mergeAuthority.requiredAlwaysHuman`, an array of `{ "name": "...", "samples": ["..."] }` with at least one sample each. An installation might copy the table above, or list its own paths such as payments or migrations. Policy files and classifier definitions still reach a person through the protected-file baseline, even with an empty list.

The check applies wherever the CLI loads the supervisor policy: `--supervisor-policy` and `--repo-dir`. Those commands read the config, from `$SUPERVISOR_CONFIG` or `.supervisor.json` in the current directory. With neither set and no `.supervisor.json`, nothing is required. A named config that is missing, unreadable or invalid exits 2. The eval checks its reference policy against the example list. A repository policy is not checked, since the rules it cannot remove are the root's.

## Review depth

The format takes no new keys, so full versus light review is expressed with what exists:

1. **The review level.** `claude/code_review(level=quick|standard|deep)`: a rule on sensitive paths asks for `deep`. The supervisor requests a review of that depth from the final reviewer.
2. **Path rules.** Light paths, such as docs and tests, need only the reviewer bot. Full paths need a person, or two seats. The strictest matching rule wins.
3. **Later, a classifier.** If paths prove a poor guide to risk, a `repo/review_depth` classifier with an ordinal output `[light, full]` can decide from the diff. With no result, the stricter verdict holds.

## What the evaluator tells an agent

`supervisor policy check <owner>/<repo> <pr>` reads the PR from GitHub through `gh api` and prints:

- the head it read
- the rules that apply
- the verdict
- the seats and who must fill them
- which seats are filled on the current head
- the review depth asked for
- whether pr-shepherd would merge that head
- the next step: merge, request a review at a given depth on that head (`request_review`, also when the only unmet seats are a bot's to fill), escalate to a person, collect classifier results (`collect_classifiers`, when a result that is missing is the only thing keeping a rule from a better verdict), or run pr-shepherd when the policy allows the merge but the head is not ready

It exits 0 only when the next step is merge. `--json` prints the same as one object, with the policy's own answer in `policyNextStep` and the final one in `nextStep`.

**A missing classifier result.** When reading a rule's overrides stops because a classifier has no result, the rule keeps its own verdict and the output says why, so a missing result is not mistaken for a condition that failed. The text output adds a line under the file, for example `Test only: override 1 not read: repo/trade_off has no result (run supervisor-classify)`, and `--json` adds `stoppedAt: {"override": 1, "missing": ["repo/trade_off"]}` to that rule's entry in `files[].rules[]` (`override` counts from 1; `missing` names each classifier of that override with no result). A rule whose own `if` has a classifier with no result is not applied; it is listed as `rule condition not read: ...` and in `files[].ifNotRead` as `{purpose, sourceFile, missing}`. Neither field changes the verdict. When such a result is the only thing keeping the check from merging (no other rule blocks or comments, no file is uncovered, and nothing else blocks), the next step is `collect_classifiers` with the `missing` classifiers, not `escalate`: run [supervisor-classify](../skills/supervisor-classify/SKILL.md) and check again. Collecting cannot widen merge authority, because the check decides again with the results in.

**What it reads.** Every caller gets the same input for the same head, because the command builds it:

| Input                                              | From GitHub                                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changedFiles`                                     | Every changed file, and a renamed file's previous name as well                                                                                                                                                  |
| `facts.filesChanged`, `filesAdded`, `filesRemoved` | Counts of the files, and of those added and removed                                                                                                                                                             |
| `facts.diffLines`                                  | Additions plus deletions                                                                                                                                                                                        |
| `facts.openedBy`                                   | The account that opened the PR                                                                                                                                                                                  |
| `facts.authors`                                    | The opener and every commit author's login                                                                                                                                                                      |
| `facts.approvedBy`                                 | Each reviewer whose latest decision is an approval of the current head. A later request for changes or a dismissal cancels an approval; a later comment does not. An approval of an earlier head does not count |
| `facts.base`, `facts.repository`, `facts.labels`   | The base branch, `<owner>/<repo>`, and the label names                                                                                                                                                          |
| `facts.teams`                                      | The members of each `<org>/<team>` the policy names                                                                                                                                                             |
| `classifiers`                                      | Not collected by `policy check`. `--classifiers <json>` supplies them, as `policy classify-collect` writes them; without it a rule that waits on a classifier stays undecided                                   |

A GitHub App is written `bot:<app slug>`, so `dependabot[bot]` is `bot:dependabot`. A person whose login is `dependabot` stays `dependabot`. No title, body, comment or commit message is read.

**When it refuses.** The command exits 2 and evaluates nothing when it cannot read the PR whole: more files than the API lists (3000), a file or commit list shorter than the PR's own count, a team it cannot read, or a head that moved while it read.

**What holds a merge the policy allows.** `--json` lists these:

- **A blocker** makes the next step `escalate`: a commit whose author has no GitHub login, a PR that is not open, or a draft. With an author unknown, `facts.authors` is left out, so a condition on `pr/authors` stays undecided.
- **An unmet bot seat** makes the next step `request_review` (at the review depth, or `standard`) when the verdict approves and every unmet seat names only bots (`bot:<app>` or `bots`). Only the final reviewer can fill it, so no person is needed: request a final review of the head. If any unmet seat can be filled by `humans`, a named person or a team, the next step is `escalate`. The reason counts each distinct seat once, as the seat lines print it. `request_review` wins over `shepherd`: a missing review and pending pr-shepherd work are independent, and the review request does not wait on CI.
- **pr-shepherd not ready** makes the next step `shepherd`: the policy allows the merge, but pr-shepherd's read-only `status` does not answer `merge` for this head. That covers a pending or failing check, a missing review, a branch rule and any other reason pr-shepherd would not merge. The next step is to run pr-shepherd on the PR. A person is not needed, so it is not `escalate`. The result's `readiness` is `{ ready, action, summary? }`: pr-shepherd's action, whether it is `merge`, and its one-line reason when it gave one. An answer with no head, or a failed call, is never ready; a failed call exits 2. A head that moved while pr-shepherd read it exits 2.

When `--dir` is left out, `supervisor policy check` resolves the policy from the supervisor configuration (`$SUPERVISOR_CONFIG`, else `.supervisor.json` in the current directory) the same way the `policy_check` MCP tool does: `mergeAuthority.policy` resolved against the config file's real path (loaded as the supervisor policy), and—unless `--repo-dir` is given—`<checkoutRoot>/<repo>` from the matching scope when that directory exists. Passing `--dir` explicitly skips resolving the policy directory and checkout from the config (no implicit layering) in either PR mode or `--input` mode: it evaluates only `--dir` (plus `--repo-dir` when explicitly passed), while the config's `mergeAuthority.requiredAlwaysHuman` floor still applies when `--supervisor-policy` or `--repo-dir` is given. Explicit values always win.

pr-shepherd reads its `.pr-shepherdrc.yml` from a checkout of the target repository: `--repo-dir` when given, else the configured `<checkoutRoot>/<repo>` checkout when `--dir` was omitted and that directory exists, else the current directory.

`--print-input` prints the collected input, with the head, `readiness` and the blockers, and evaluates nothing. `supervisor policy check [--dir <policy dir>] --input <json>` evaluates a written input file instead, for dry runs and the eval. A written input has no readiness and no blockers. An input that `--print-input` printed carries both, and they hold the merge on replay as they did live. An input with the old `checks` key is refused: print it again.

`--repo-dir <checkout>` layers the repository's own policy files below the supervisor policy (and sets where pr-shepherd reads its config). Keep both explicit `--repo-dir` checkouts and configured `<checkoutRoot>/<repo>` checkouts on the default branch, never on a PR's head. Without an explicit or configured checkout, the policy directory alone is evaluated.

`supervisor policy explain <dir> [path] [--repo-dir <checkout>]` describes the policy without a PR. Under `policyEngine: "compare"` the check also reads the Claude Approvals check and reports any disagreement.

### The `request_review` round trip

When `nextStep.action` is `request_review`, the policy approves the PR once its bot seat (or `claude/code_review` classifier) is satisfied on the current head:

1. **The request:** the supervisor requests a final review of that head at `nextStep.depth`, once per head (tracked in `escalations` as `final-review:<owner>/<repo>#<N>@<head>`), using `finalReview.request`: `session` sends a message to the standing final-reviewer session (such as the `code-reviewer` loop session) naming the PR, head SHA, and depth; `label` adds `finalReview.label` (removing and re-adding it if present from an older head); both runs both. The supervisor leaves the PR ready, reports `awaiting-final-review`, and does not block waiting.
2. **The reviewer's review on the head:** the final reviewer inspects that exact head SHA and submits its review on GitHub (an approval that fills the `bot:<review app>` seat, and/or a review body carrying the `<!-- final-review ... -->` marker for `claude/code_review`).
3. **The next policy check sees the seat filled:** when a later sweep runs or a review event wakes the loop, `supervisor policy check` (or `policy_check`) reads the updated reviews for that head from GitHub and sees the bot seat filled (and with `classify-collect`, maps the final review to `claude/code_review`).
4. **pr-shepherd reports ready:** if `readiness.ready` is still false (for example `triage` or `wait`), `nextStep` becomes `shepherd` — the supervisor runs `pr-shepherd` on the PR until the head is ready. Any new commit pushed during triage starts a fresh round trip for the new head. Once `pr-shepherd` answers `merge` for the reviewed head, the next policy check returns `nextStep.action: "merge"`.
5. **The merge:** the supervisor writes the merge record (`supervisor state merge-record`) from that check JSON (and verifies `finalReview.status` when configured) and merges through `pr-shepherd`.

### The `policy_check` MCP tool

`supervisor mcp` exposes `policy_check` so a worker can ask what its PR needs. It runs the same check as `supervisor policy check <owner>/<repo> <pr> --dir <policy-dir> --supervisor-policy [--repo-dir <checkout>] --json` and returns the same JSON object — verdict, seats, review depth, readiness, blockers, `policyNextStep`, and `nextStep` for the current head — both as `structuredContent` and as JSON text in `content`. When the PR, config, policy, or arguments cannot be read or validated, it returns `isError: true` with the reason.

- **`repository`** (required): `<owner>/<repo>`.
- **`pr`** (required): pull request number.

Everything that decides the verdict comes from the supervisor configuration (`$SUPERVISOR_CONFIG`, else `.supervisor.json` in the working directory), never from tool arguments: the server resolves `mergeAuthority.policy` against the real path of the config file's directory as the supervisor policy, enforces `mergeAuthority.requiredAlwaysHuman`, and layers `.supervisor/approvals.yml` (and locates `.pr-shepherdrc.yml`) from `<checkoutRoot>/<repo>` when a matching scope configures `checkoutRoot` and that directory exists. Any extra argument (such as a policy directory, checkout path, or classifier results) is refused.

## A sketch

Placeholders are in angle brackets; a real file cannot hold them.

```yaml
version: 1
locals:
  reviewed: [{ count: 1, from: 'bot:<review app>' }]
rules:
  - purpose: 'Nothing merges on its own unless a carve-out applies.'
    paths: ['**', '!**/test/**', '!docs/**']
    verdict: { claude: comments, seats: 1 }
    override:
      - { if: 'ALL pr/authors = bot:dependabot', verdict: { claude: approves, seats: '@reviewed' } }
      - { if: 'repo/flake_fix = yes', verdict: { claude: approves, seats: '@reviewed' } }
  - purpose: 'Test-only and docs-only changes merge once the reviewer approves.'
    paths: ['**/test/**', 'docs/**']
    verdict: { claude: approves, seats: '@reviewed' }
  - purpose: 'Always a person: CI workflows, release and signing, migrations, payments.'
    paths:
      [
        '.github/workflows/**',
        '**/release/**',
        '**/signing/**',
        '**/migrations/**',
        '**/payments/**',
      ]
    nested: inherit
    verdict: { claude: comments, seats: 1 }
  - purpose: 'A change to merge rules always goes to a person.'
    paths:
      [
        '**/.supervisor/**',
        '**/.claude/approvals.yml',
        '**/.claude/approvals.yaml',
        '**/.claude/classifiers/**',
      ]
    nested: inherit
    verdict: { claude: comments, seats: 1 }
```
