# Configuration

Everything that can differ between owners, repositories or machines is data in one JSON file per installation. This repository holds the schema and an example with no real names. The file itself is kept in a private config repository, because it names private scopes.

[Back to the graph](graph.md)

- **Shape:** [schemas/config.json](../schemas/config.json) defines every key. The state file `supervisor state` writes has its own schema, [schemas/state.json](../schemas/state.json). [examples/config.example.json](../examples/config.example.json) is a complete file.
- **Location:** the `SUPERVISOR_CONFIG` environment variable names the file. Without it, `supervisor state` and `supervisor wait` read `.supervisor.json` in the current directory.
- **Check:** `supervisor config validate [path]` validates a file against the schema, and defaults to `$SUPERVISOR_CONFIG`.

## Paths

Only `mergeAuthority.policy` may be relative to the configuration file, as described under [Who may merge](#who-may-merge). `stateDir` and each scope's `checkoutRoot` expand a leading `~/`, or a bare `~`, to the home directory and are used otherwise as written, so a relative value would follow the working directory: write them absolute or with `~/`. `scheduledPrompts` paths are relative to each repository.

## Defaults and overrides

Top-level values are defaults, and a scope overrides them. `provenance.fields` shows the pattern: the top level lists the fields every [claim](claims-and-taxonomy.md#claims) carries, and one scope can list its own, for example to add the machine name where several machines work on the same repositories.

## Scopes

A scope is one GitHub owner and the repositories the supervisor covers there.

- **`kind`** is `org` or `user`. It matters because GitHub lists an organization's repositories and a user account's repositories through different endpoints, so the wait lists each owner's repositories its own way, then runs one wait over every owner with one cursor. A `user` scope needs `gh` signed in as a user: the wait calls `gh api user` to tell whether the owner is the signed-in account, and that call fails with an installation token or the Actions `GITHUB_TOKEN`, so the wait fails too.
- **`repos`** is `"*"` or a list of names. With `"*"`, `excludeForks` and `excludedRepos` narrow it. With a list, only those repositories are supervised. Archived repositories are always skipped.
- **`mode`** is `enforce` or `report`. `enforce` runs every phase. `report` triages and reports, with no worker PRs and no merges. It suits a scope with outside contributors, where the [untrusted-text rule](guardrails.md) and live collaborator authorization carry more weight. When rolling out a new installation, start in `report` mode and move one scope to `enforce` at a time, smallest first: before switching a scope, run the preflight checks for dispatch targets and labels (`supervisor preflight --enforce-scope <owner>`) as if that scope were already in `enforce`, and approve any harness permission prompt (such as a terminal multiplexer running outside the sandbox) before editing the config. See [skills/supervisor-loop/references/rollout.md](../skills/supervisor-loop/references/rollout.md).
- **`taxonomy`** holds a scope's own milestone and project conventions, such as which project a repository's issues belong to.

## Who may merge

`mergeAuthority` says who may merge at all, and which evaluation to trust. It does not say what a PR needs.

- **`policy`** is the path to the supervisor policy directory. A relative path resolves against the directory of the configuration file after following symlinks (its real path), never against the working directory or the link's own directory: `dirname "$(realpath "${SUPERVISOR_CONFIG:-.supervisor.json}")"`. A quoted leading `~/` in the variable is expanded by the CLI but not by this command, so write the variable with the home path expanded. Both `supervisor policy check` (when `--dir` is omitted) and the MCP tool `policy_check` resolve `mergeAuthority.policy` this way from the configuration, and resolve the repository checkout from the matching scope's `checkoutRoot` (following the [Paths](#paths) rule above) unless `--repo-dir` is given; passing `--dir` explicitly skips resolving the policy directory and checkout from the config (no implicit layering) in both PR mode and `--input` mode—though `mergeAuthority.requiredAlwaysHuman` still applies when `--supervisor-policy` or `--repo-dir` is given—and explicit CLI flags always win. Merge rules are not in the config file. They live in that policy and in repository policies, in the `approvals.yml` format: see [merge-policy.md](merge-policy.md).
- **`policyEngine`** picks the evaluation: the supervisor's own, the Claude Approvals check, or both compared. See [merge-policy.md](merge-policy.md#staying-compatible-with-claude-approvals).
- **`requiredAlwaysHuman`** (optional) lists the paths the supervisor policy must send to a person, each as a `name` and one or more `samples`. Empty or absent means nothing is required. See [merge-policy.md](merge-policy.md#the-always-human-rules-a-supervisor-policy-must-have).
- **`hosts`, `models` and `attendedOnly`** are meant to limit merging to named machines, named models and an attended session, while a session outside them still runs workers and sweeps. Not enforced yet: nothing in the supervisor reads these three keys.

## Requesting the final review

`finalReview` says how to ask the final reviewer for a review of a head: a message to its session, a label on the PR, or both. `label` names that label. Optional `reviewer` names the reviewer's GitHub account (`bot:<app slug>` or `<login>`) whose final review `classify-collect` maps to `claude/code_review`. The supervisor requests a review of each head once; for a head that follows an earlier request it removes the label and adds it again.

Whether a review is required is a rule in the merge policy, not a setting here.

## Event wait

`eventWait` (optional) enables `supervisor wait`, which polls the hook-harness relay in-process through supervisor's bundled `hook-harness` client using credentials from `HOOK_HARNESS_URL` and `HOOK_HARNESS_TOKEN` or `hook-harness login`. The relay URL must use `https:` (`http:` is allowed only for `localhost`, `127.0.0.1`, and `[::1]`).

- **`timeout`** (default `"2h"`) is how long one wait runs before returning `timedOut: true`.
- **`advance`** (default `false`) advances the stored cursor and marks returned event ids seen at return instead of waiting for `supervisor state advance-hh`.
- **`updateCheckDelay`** (default `"10m"`) bounds how long the wait stays idle after a dependency-bot pull request merges cleanly.
- **`hookHarness`** (deprecated) is accepted for compatibility with older configuration files and ignored, because `supervisor` now uses its bundled `hook-harness` dependency directly.

## Sweep cap

`sweepCap` (optional) bounds how much new work one `enforce`-mode sweep creates, so switching a scope from `report` to `enforce` (or recovering from a backlog) drains across sweeps instead of acting in one burst.

- **`issues`** (integer >= `0`, default `10`) is the maximum number of new issues filed in one sweep across all phases.
- **`dispatches`** (integer >= `0`, default `5`) is the maximum number of worker or workspace-agent dispatches in one sweep across all phases (flakes, default-branch failures, dependency-bot update failures, intake, one-off issues, `/fix` commands, and scheduled prompts).

Work over either cap waits for the next sweep, the sweep summary reports how much was held back, and cursors advance only past the work that was actually done. Held-back work never expires: the next sweep's scan window starts at the held-back cursor even when that is older than the phase's usual rolling window. Setting either value to `0` holds back that kind of work while still running the rest of the sweep.

## Scheduled prompts

`scheduledPrompts` (optional) enables Phase G3's round-robin maintenance prompt rotation across selected `enforce`-mode repositories.

- **`quota`** (number >= `0`, default `1`) is the maximum number of prompts selected in one rotation window.
- **`history`** (integer >= `0`, default `20`) is how many completed run records `scheduledPrompts.runs` retains. It must be greater than or equal to `quota` so an interrupted rotation does not evict the lap markers Rotate needs to skip already-completed prompts; configurations with `history < quota` (including when either key uses its default) are refused when validated or loaded.

## Labels

`labels` names the two labels the supervisor uses in `enforce` scopes: `automation` (marks worker PRs for the triage queue; never grants merge authority) and `needsHuman` (added when escalating a PR or issue to a person). Both must already exist in every repository acted on. `supervisor preflight` checks whichever of the two keys are configured across `enforce` scopes (and any owner passed via `--enforce-scope <owner>`); when `labels` sets neither key, the check is skipped as `ok`. If a configured label is missing in a repository, preflight reports it (`ok`, detail `missing: ...`, without exiting 1) and never creates it — creating labels is left to a person. Escalation still happens without `labels.needsHuman` (noting the missing label in the summary), while worker dispatches are skipped for any repository missing `labels.automation` because their PRs could not carry the label and would drop out of triage.

## Comment command authorization

Comment commands (`/shepherd`, `/plan`, `/fix`) are authorized live by repository collaborator permission through `supervisor auth check <owner>/<repo> <login>`: only non-bot `User` accounts with push access or higher (`write`, `maintain`, or `admin`) are allowed, API errors fail closed, and nothing is stored in state.

- **`trustedLogins`** (deprecated) is accepted by the schema for compatibility with existing configuration files and ignored; nothing in the supervisor reads it.
