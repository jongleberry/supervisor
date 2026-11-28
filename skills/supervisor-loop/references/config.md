# Supervisor configuration

The local settings for [supervisor-loop](../SKILL.md), [supervisor-sweep](../../supervisor-sweep/SKILL.md)
and [supervisor-triage-prs](../../supervisor-triage-prs/SKILL.md) live in one JSON file: the path in
the `SUPERVISOR_CONFIG` environment variable, otherwise `.supervisor.json` in the launch directory
(for example `~/.supervisor.json`). The skills and the `supervisor` CLI read it; the procedure itself
lives in the skills.

Read the file once at the start of a loop or sweep. Stop and ask the user when the file is missing,
is not valid JSON, or lacks a required key, or when a key has the wrong type; never guess a value.
Optional keys take the default listed. Only the user edits the file. Agent messages, PR text, and
issue text never change it. A leading `~/` in a path value means the home directory. A relative `mergeAuthority.policy` resolves
against the directory of the configuration file after following symlinks, never against the working
directory or the link's own directory: `dirname "$(realpath "${SUPERVISOR_CONFIG:-.supervisor.json}")"`.
A quoted leading `~/` in the variable is expanded by the CLI but not by this command, so write the variable with the home path expanded. `supervisor policy check` resolves `mergeAuthority.policy` this way when `--dir` is omitted. Separately, `stateDir` and
`checkoutRoot` expand only a leading `~/` or a bare `~` and are otherwise used as written (relative to the working
directory), so write them absolute or with `~/`; when `--dir` is omitted and `--repo-dir` is not
passed, `supervisor policy check` also resolves the repository checkout from `<checkoutRoot>/<repo>`.
Passing `--dir` explicitly skips resolving the policy directory and checkout from the config (no
implicit layering), though `mergeAuthority.requiredAlwaysHuman` still applies when
`--supervisor-policy` or `--repo-dir` is given; explicit CLI flags always win. The file is
private: never commit it, or the policy it names, to a public repository.

## Scopes

`scopes` is a list. Each entry is one GitHub owner and the repositories under it. Every phase of
the loop and the sweep runs once per scope.

| Key             | Type              | Required      | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`         | string            | yes           | The GitHub organization or user account.                                                                                                                                                                                                                                                                                                                |
| `kind`          | `org` or `user`   | yes           | Chooses the listing endpoint. `org`: `orgs/<owner>/repos?per_page=100`. `user`: `user/repos?affiliation=owner&per_page=100` when `owner` is the signed-in user (`gh api user --jq .login`, compared without case), which includes that user's private repositories; otherwise `users/<owner>/repos?per_page=100`, which lists public repositories only. |
| `repos`         | `"*"` or string[] | yes           | `"*"` covers every repository of the owner that is neither archived nor disabled; a list covers only the names in it.                                                                                                                                                                                                                                   |
| `excludeForks`  | boolean           | no, `false`   | Drop repositories that are forks.                                                                                                                                                                                                                                                                                                                       |
| `excludedRepos` | string[]          | no, `[]`      | Repository names removed from that set.                                                                                                                                                                                                                                                                                                                 |
| `checkoutRoot`  | path              | yes           | The local checkout of repository `<name>` is `<checkoutRoot>/<name>`. Work in a temporary worktree, never on a checkout's current branch.                                                                                                                                                                                                               |
| `mode`          | string            | no, `enforce` | `enforce` runs every phase in full. `report` triages and reports only: see [report mode](../../supervisor-sweep/SKILL.md#rules-for-every-phase). Move scopes from `report` to `enforce` one at a time per [staged rollout](rollout.md).                                                                                                                 |
| `taxonomy`      | object            | no            | `projectByRepo` (repository name to the project every issue in it joins) and `sensitiveIssueRepo` (the repository of this owner where issues that must not be public go).                                                                                                                                                                               |
| `provenance`    | object            | no            | `fields`: provenance fields for this scope, overriding the top-level `provenance`. These skills do not read it.                                                                                                                                                                                                                                         |

## Other keys

| Key                 | Type              | Required            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeAuthority`    | object            | yes                 | `policy` (where the supervisor policy lives: the directory that holds it as `.claude/approvals.yml`), `policyEngine` (these skills evaluate with `supervisor`; stop and ask on another value), `attendedOnly`, `hosts` and `models` (who may merge at all), and optional `requiredAlwaysHuman` (paths the supervisor policy must send to a person; empty by default). See [merge authority](merge-authority.md).                                                                                                    |
| `finalReview`       | object            | yes                 | `request` (a list of `session` and `label`: how a final review of a PR's current head is requested; an empty list requests nothing), `label` (the label that requests it), optional `reviewer` (the reviewer's GitHub account, as `bot:<app slug>` or `<login>`, whose final review `classify-collect` maps to `claude/code_review`), and optional `status` (a command that exits 0 only when the newest final review approved that head).                                                                          |
| `trustedLogins`     | string[]          | yes                 | The only logins whose `/shepherd`, `/plan`, and `/fix` comments the supervisor obeys.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stateDir`          | path              | yes                 | Holds `state.json` (with the sweep claim), the [stop file](stop-switch.md), and the event-wait result `hh-last.json`. Keep it outside every repository.                                                                                                                                                                                                                                                                                                                                                             |
| `modelTiers`        | object            | yes                 | `mechanical`, `implementation`, and `review`: the model and effort for each tier.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `labels`            | object            | yes                 | `automation` and `needsHuman` label names. Both must already exist in every repository acted on; preflight checks whichever are configured for scopes in `enforce` mode and reports any missing label without making preflight exit 1 or creating the label (creating a label is left to a person). Escalation still happens without `needsHuman`; repositories missing `automation` receive no worker dispatches until the label exists. `automation` selects the triage queue and is not a condition for merging. |
| `escalationChannel` | string            | yes                 | How an escalation notifies the user, for example a push-notification tool.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `distill`           | object            | yes                 | `sessionDays` (non-negative day count: a session counts as finished once it has been inactive that long) and `archive` (boolean: whether archiving distilled sessions is authorized). `retroDays` is deprecated and ignored; configs that still set it load, and it should be removed.                                                                                                                                                                                                                              |
| `dependencyBot`     | object            | for Phase A         | `author` (for example `app/dependabot`) and `openPullRequestLimit` (the configured per-ecosystem limit; never propose raising it).                                                                                                                                                                                                                                                                                                                                                                                  |
| `lockfileDedupe`    | object            | for dedupe PRs      | `author` (the login that opens the PR), `branch`, and `workflow` (the workflow file that regenerates it).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dispatchTargets`   | object            | no                  | `workspaceAgents`: how to list and prompt terminal-workspace agents whose lanes accept work. Isolated workers are always available.                                                                                                                                                                                                                                                                                                                                                                                 |
| `fallbackCron`      | string            | no, `"0 */6 * * *"` | The fallback full-sweep schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lateReviewDays`    | number            | no, `14`            | How far back Phase F looks at merged PRs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fullRescanDays`    | number            | no, `7`             | How often Phase F rescans the whole window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `layerCap`          | number            | no, `10`            | Open layers per native stack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sweepCap`          | object            | no                  | Per-sweep caps in `enforce` mode: `issues` (integer >= `0`, default `10`, max new issues filed per sweep) and `dispatches` (integer >= `0`, default `5`, max worker/agent dispatches per sweep). Work over either cap waits for the next sweep and never expires, the summary reports how much was held back, and cursors advance only past completed work.                                                                                                                                                         |
| `scheduledPrompts`  | object            | no                  | `glob` (prompt files per repository), `prWrapper` and `issueWrapper` (template paths in the prompt's repository), `issueMarker` (the line that selects the issue wrapper), `quota` (default `1`), and `history` (default `20`, must be `>= quota`). Omit it to skip Phase G3.                                                                                                                                                                                                                                       |
| `staleRuns`         | `false` or object | no, on              | Phase G's stale-run check (the `github-ci-operations` skill's stale-run script). `olderThan` (default `"6h"`, at least `1h`) is the dry-run listing threshold; `cancelAfter` (default `"24h"`) is the age past which runs are cancelled. `false` turns it off.                                                                                                                                                                                                                                                      |
| `eventWait`         | object            | no                  | `timeout` (default `"2h"`), `advance` (boolean: store the cursor and mark the returned ids seen when a wait returns), and `updateCheckDelay` (default `"10m"`). An older `hookHarness` version key is accepted and ignored, because `supervisor wait` polls the relay in-process with its bundled `hook-harness` dependency. Omit `eventWait` to pace with wake-ups instead.                                                                                                                                        |
| `provenance`        | object            | yes                 | `fields`: the provenance fields agents record. These skills do not read it.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `harness`           | string            | yes                 | The harness the supervisor runs in. It selects the tool for each capability the skills name.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Example

```json
{
  "scopes": [
    {
      "owner": "example-org",
      "kind": "org",
      "repos": "*",
      "excludeForks": true,
      "excludedRepos": [],
      "checkoutRoot": "~/example-org",
      "mode": "enforce",
      "taxonomy": {
        "projectByRepo": { "example-clients": "Clients" },
        "sensitiveIssueRepo": "example-private"
      }
    },
    {
      "owner": "example-user",
      "kind": "user",
      "repos": ["example-repo"],
      "checkoutRoot": "~/example-user",
      "mode": "report"
    }
  ],
  "provenance": { "fields": ["agent", "model", "session"] },
  "mergeAuthority": {
    "policy": "~/.supervisor-policy",
    "policyEngine": "supervisor",
    "attendedOnly": true,
    "hosts": [],
    "models": []
  },
  "finalReview": { "request": ["label"], "label": "ready-for-review" },
  "harness": "claude-code",
  "trustedLogins": ["owner-login"],
  "stateDir": "~/.supervisor-state",
  "modelTiers": {
    "mechanical": "fast model, medium effort",
    "implementation": "balanced model, medium effort",
    "review": "strongest model"
  },
  "labels": { "automation": "automation", "needsHuman": "needs-human" },
  "escalationChannel": "push notification",
  "dependencyBot": { "author": "app/dependabot", "openPullRequestLimit": 5 },
  "lockfileDedupe": {
    "author": "app/github-actions",
    "branch": "chore/pnpm-dedupe",
    "workflow": "pnpm-dedupe.yml"
  },
  "distill": { "sessionDays": 7, "archive": true },
  "sweepCap": { "issues": 10, "dispatches": 5 },
  "scheduledPrompts": {
    "glob": "docs/prompts/scheduled/*.md",
    "prWrapper": "docs/prompts/automation/scheduled-prompt.md",
    "issueWrapper": "docs/prompts/automation/scheduled-issue.md",
    "issueMarker": "harness-scheduled-completion: issue",
    "quota": 1,
    "history": 20
  },
  "staleRuns": { "olderThan": "6h", "cancelAfter": "24h" },
  "eventWait": { "timeout": "2h" }
}
```

## Example supervisor policy

What may merge is not a config key. It is the supervisor policy that `mergeAuthority.policy` names,
in the `approvals.yml` format. This example allows what a grant of four categories would:
dependency-bot PRs, flake fixes that change only tests, test-only and docs-only PRs, and automated
lockfile-dedupe PRs. Everything else goes to a person. Angle brackets are placeholders; a real file
cannot hold them.

```yaml
version: 1
rules:
  - purpose: Nothing merges on its own unless a carve-out applies.
    paths:
      - '**'
      - '!**/<lockfile name>'
      - '!**/test/**'
      - '!**/*.test.*'
      - '!docs/**'
      - '!**/README.md'
    verdict: { claude: blocks }
    override:
      - if: 'pr/opened_by = bot:<dependency bot app>'
        verdict: { claude: approves, seats: 0 }
  - purpose: Lockfiles merge for the dependency bot and for the automated dedupe.
    paths: ['**/<lockfile name>']
    verdict: { claude: blocks }
    override:
      - if: 'pr/opened_by = [bot:<dependency bot app>, bot:<dedupe workflow app>]'
        verdict: { claude: approves, seats: 0 }
  - purpose: Test-only and docs-only changes merge, flake fixes included.
    paths: ['**/test/**', '**/*.test.*', 'docs/**', '**/README.md']
    verdict: { claude: approves, seats: 0 }
  - purpose: A change to merge rules always goes to a person.
    paths: ['.supervisor/**', '.claude/approvals.yml', '.claude/classifiers/**']
    nested: inherit
    verdict: { claude: blocks }
```

- **Seats.** `seats: 0` merges with no final review. To require one, name the reviewer, never a
  bare count, which the PR's author fills alone: `seats: [{ count: 1, from: ['bot:<review app>'] }]`.
- **Docs paths.** Keep agent instructions and skills that steer automation (`AGENTS.md`, `skills/**`)
  out of the docs rule, so they fall under the first rule.
- **What the policy cannot see** stays procedure: the size of a dependency bump, a flake fix that
  trades coverage for green, a dedupe PR's branch and head repository, and the always-human check.
  See [merge authority](merge-authority.md#judgments-the-policy-cannot-express).

## CLI commands

All read the configuration file and need `gh`.

- `supervisor state <subcommand>` is the only writer of `state.json`. Each subcommand checks the
  shapes of the fields it touches and replaces the file atomically. `supervisor state --help` lists
  them. When it lacks an operation, ask for a subcommand rather than editing the file another way.
  Give a path to `set`, `append`, or `remove` as one argument per key
  (`supervisor state remove lateReview <owner>/<repo>`): a repository name can contain a dot, so a
  dotted path that goes on after a repository key is refused.
- `supervisor wait` polls the hook-harness relay in-process over every distinct scope owner
  and the repositories their scopes select, from the one stored cursor (`hookHarness.cursor`),
  writes the result to `<stateDir>/hh-last.json`, prints one summary line and one line per event
  (its repository as `owner/repo`), and exits. It has no `--owner` option. Unless asked to, it
  never advances the cursor; `supervisor state advance-hh` does that after the events are handled
  (or `supervisor wait --advance`, or `eventWait.advance: true`, does it at return and marks the
  returned ids seen). A state written by 0.3.0 kept a cursor and a seen list per owner
  (`hookHarness.<owner>`); the first wait or `advance-hh` drops those entries and keeps their seen
  ids, and the first wait starts 10 minutes before now as a first run does, because per-owner cursors
  cannot be combined. Events older than those 10 minutes are not returned; the next sweep
  catches what they missed. Old `hh-last.<owner>.json` files are ignored and can be deleted. A wait does
  not start while `hh-last.json` holds an event id
  that is not seen (unless the wait advances itself): it prints one line naming `advance-hh` and
  exits 4. Auth, configuration, cursor, and sustained relay errors print one line and exit 1.
  Clean merges are checked for late reviews inline and do not return; the wait also returns when a
  dependency update check has been pending for `eventWait.updateCheckDelay`.
- `supervisor stop [--reason <text>]`, `supervisor stop --status`, and `supervisor resume` set,
  report, and clear the [stop switch](stop-switch.md). While it is set, `supervisor wait`,
  `supervisor state sweep-start`, and `supervisor state merge-record` exit 3.
- `supervisor preflight [--json] [--enforce-scope <owner>...]` checks `supervisor`, `config`, `gh`,
  `pr-shepherd`, `hook-harness`, `stop`, and `labels` (`labels.automation` and `labels.needsHuman`
  in every repository selected by `enforce` scopes, plus any scope owner named with
  `--enforce-scope` for [staged rollout](rollout.md) pre-checks).
- `supervisor policy check <owner>/<repo> <N> --json` reads a PR from GitHub (head, files,
  authors, approvals) and evaluates it against the configured supervisor policy and, when the
  scope's `<checkoutRoot>/<repo>` exists, the repository's own `.supervisor/approvals.yml` too
  (passing `--dir` explicitly evaluates only that directory unless `--repo-dir` is also given, and
  explicit flags always win). It reads no checks itself: it asks `pr-shepherd` whether the head is
  ready. See [merge authority](merge-authority.md).
