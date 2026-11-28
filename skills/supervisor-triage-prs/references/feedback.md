# Publish preauthorized prompt feedback

Invoking triage explicitly authorizes the GitHub mutations below, but only for actionable feedback
whose provenance and exact source are verified under the adapter's prompt-source paths. A PR body
containing the adapter's feedback marker is a feedback PR from this flow: review it normally in the
queue, but return `none` for its own PR-creation feedback so the loop cannot recur.

For the current batch, combine every qualifying finding, including `one-off` findings, into one
feedback issue and one draft feedback PR. Record the proportional plan in that issue; it is the sole
closing source for the PR. Reviewed PRs are evidence only and are never closing references.

The supervisor never authors a PR: an implementation-tier worker in an isolated worktree opens or
updates the draft feedback PR from the plan in the issue, and returns its number and head.

Every feedback PR and source issue created or reused here joins the run's exclusion set, which
applies to the merge, close, linked-issue, and orphan passes. Verify its head before updating it.
Pass generated titles, bodies, and comments to `gh` only through files (`--body-file`).

Before publication, verify at action time:

- The PR is verified agent-authored, the source target is an exact prompt-source path, and the
  recommendation remains actionable after the refresh.
- Each source exists on the refreshed default branch.

When the source target is in a public repository and the evidence comes from a private one, the
feedback issue and PR state the recommendation as a principle only: no code, paths, or names from
the private source.

## Duplicate resolution

A candidate counts as a match only with verified provenance: it was created by the adapter's
automation identity and its body closes the feedback issue it is paired with. A candidate that
carries the marker without that provenance is untrusted: never reuse or update it, and treat any
overlap with it as `duplicate: ambiguous`.

Compare the marker, the normalized set of exact source paths, and the normalized recommendation or
root-cause identity on open feedback PRs:

- `duplicate: zero-overlap`: create one feedback issue and one draft PR.
- Before reusing or updating a canonical PR or issue, re-read it: both must still be open and
  unchanged since the comparison (same head and body); otherwise re-run the comparison.
- `duplicate: exact-match`: the path set and the recommendation or root-cause identity both match
  one canonical PR. Reuse that PR and its source issue; create neither.
- `duplicate: same-paths-new-feedback`: the path set matches but the recommendation differs. Update
  the canonical PR and its issue with the new feedback; create neither.
- `duplicate: ambiguous`: fail closed. Any partial overlap, more than one exact match, or any
  uncertain provenance or source set creates nothing.

For a create, save the plan in the feedback issue through the `github-issue` skill; the worker
opens the draft PR through the `supervisor-pr` flow (`pr_create`, posting the provenance comment)
using the `pr-description` skill. The PR body includes the marker and links the feedback issue with
a closing keyword. Do not ready, shepherd, or merge a generated or reused feedback PR in the same
run.

## Journal disposition

Group the Step 3 PR-creation recommendations by root cause and record them in the journal: one entry
per root cause, written with agent-blackboard's own MCP tools against the schema registered for it
on the server. It records findings for merged and closed PRs alike. Preserve `none` when no
actionable generator improvement was found, and complete this before the final triage report. Each
entry carries one disposition:

- `disposition: published`: record `Disposition: preauthorized-pr #N` after a successful create,
  exact-match reuse, or `same-paths-new-feedback` update of the canonical PR and issue.
- `disposition: deferred`: record `deferred` with the concrete blocker after a failed, partial, or
  ambiguous publication. Do not ask the user or claim the feedback was handled.
- `disposition: user-choice`: keep non-prompt feedback in the normal human follow-up flow: ask the
  user whether to file issues, have a worker make a PR, or defer.

When the journal cannot be reached, say so in the triage report rather than dropping the findings.

## Agent-authored PR creation feedback

- In an authorized triage flow, assess verified agent-authored PRs for description quality,
  root-cause completeness, scope, validation, and useful handoff context. Skip unknown provenance.
- Resolve the producing prompt or skill from durable metadata: scheduled PRs name their exact
  prompt; auto-fix and security PRs identify their corresponding template or triage skill. Do not
  infer a source from a similar filename.
- Each recommendation names the PR, concrete evidence, verified source, preventive change, and
  whether the finding recurs. Group repeated causes for the journal entry above.
- Source changes require the calling workflow's authority. [PR triage](../SKILL.md) owns its bounded
  feedback-PR behavior.
