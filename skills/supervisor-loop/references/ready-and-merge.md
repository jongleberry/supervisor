# Ready and merge

The supervisor's own procedure for moving a PR it reviewed to ready and merging it through
`pr-shepherd`. `supervisor-sweep`, `supervisor-triage-prs`, and the `/shepherd` handler use it. It
is not a general "mark any draft ready" tool: an agent working its own PR runs `pr-shepherd` itself.

Inputs: a PR number, `--repo <owner>/<repo>` (pass it on every `gh` command), optional `--merge`
(only for a PR the [merge authority](merge-authority.md) may cover), and optional
`--steer-file <path>`. The [configuration](config.md) supplies the policy;
stop and ask when it is missing.

In a scope in `report` mode, run step 1 only and report what the later steps would have done.

1. **Resolve and light review.** Resolve the PR in `--repo`; reject one from another repository.
   Record `headRefOid`, read the diff and CI state, and decide whether `pr-shepherd` needs direction
   (for example "prefer the general fix over a narrow band-aid"). Write steering with a file-writing
   tool, never shell interpolation, and read it back in full.
2. **Preflight.** Before every mutation below, run `supervisor stop --status` and go no further on
   any exit but 0 (see the [stop switch](stop-switch.md)), then re-read `headRefOid`; if it moved,
   return for re-review. Run `pr-shepherd`; exit 17 (`WATCHED`) means another live `pr-shepherd`
   already watches the PR, so leave it.
3. **Steer (optional).** Post the reviewed steering file as an ordinary comment with
   `gh pr comment <N> --repo <owner>/<repo> --body-file <path>`. Reject an empty file.
4. **Mark ready.** Run `gh pr ready <N> --repo <owner>/<repo>` for a draft (the supervisor
   does this itself: `pr-shepherd` marks ready only clean drafts with auto mark-ready on). Do not
   apply any label here; Phase B selects open PRs by their supervisor provenance comment.
5. **Check the merge authority (only with `--merge`).** Run every step of
   [before any merge](merge-authority.md#before-any-merge) for the current head, and again after new
   commits. A printed enqueue or requeue command counts as a merge. The policy check is
   `supervisor policy check <owner>/<repo> <N> --json` (omitting `--dir` resolves both
   `mergeAuthority.policy` and `<checkoutRoot>/<repo>` from the configuration; passing `--dir`
   explicitly skips resolving the policy directory and checkout from config, though
   `mergeAuthority.requiredAlwaysHuman` still applies with `--supervisor-policy` or `--repo-dir`);
   keep its output in a file,
   and merge only the head in its `pull.head`.
   - When the policy check's next step is `request_review`, request a final review of the current
     head at the depth it names, as `finalReview.request` says, at most once per head. The record,
     in both modes, is the `escalations` key `final-review:<owner>/<repo>#<N>@<head>`: read it with
     `supervisor state show escalations`. When it is present, send nothing. When it is absent,
     request the review, then write it with
     `supervisor state set escalations 'final-review:<owner>/<repo>#<N>@<head>' --json '"<ISO time>"'`.
     `session` messages the final reviewer's session with the PR and head. `label` adds
     `finalReview.label`; if the label is already on the PR from an older head, remove it and add
     it again so the reviewer's label trigger fires for this head. A new head is a new key, so a
     pushed fix gets a new request. Either way leave the PR ready and report
     `awaiting-final-review`. A later sweep reruns the check. Nothing waits on the reviewer.
   - When `finalReview.status` is configured, run it too: exit 0 means the newest final review
     approved the current head. Any other exit code means do not merge.
   - When the policy check's next step is `shepherd`, the policy allows the merge but
     `pr-shepherd` would not merge the head yet, often because a check is pending. Leave the PR
     ready, run `pr-shepherd` on it, and rerun the check on the head it reaches. Do not escalate.
   - Any other outcome than "may merge" leaves the PR ready and escalated.

   This gate is procedural: GitHub enforces a review only through a required status check, or
   branch protection that dismisses stale approvals, which the consuming repository owns.

6. **Merge through `pr-shepherd` (only with `--merge`, and only when step 5 said the supervisor may
   merge this head).** Write the [merge record](merge-authority.md#merge-record) with
   `supervisor state merge-record` from that check file and go on only when it exits 0, then run
   `pr-shepherd` as the `pr-shepherd` skill directs (a stack per [Stacks](#stacks)). The supervisor
   session runs each PR's shepherd poll itself. A subagent never runs a `pr-shepherd` poll
   (`pr-shepherd [PR]` or `pr-shepherd stack`); the fixer runs the printed post-push
   `pr-shepherd apply` commands from its own worktree, so `--require-sha HEAD` resolves to the
   commit it pushed. Run the shepherd from `<checkoutRoot>/<name>` so the repository's own
   configuration loads (`--until-terminal` exits on every TRIAGE and is rerun until `[CANCEL]` or
   `[ESCALATE]`). After any push the head is new: step 5
   runs again before anything merges. A steered PR is not merged in this pass: leave it ready,
   report `steered-hold`, and let a later sweep merge it. Still shepherd it without `--merge`, so
   its steering and any required fix are carried out.
7. **Verify and report.** For a PR with no shepherd running,
   `gh pr view <N> --repo <owner>/<repo> --json isDraft,state`. Report per PR: ready, steered, merge
   (merged, pending, steered-hold, awaiting-final-review, no), `pr-shepherd` (running or no), and
   the reason for any `no`.

The supervisor never posts `/shepherd` to itself: `/shepherd` is how another agent delegates a PR to
it.

## Stacks

The `pr-shepherd` skill owns stack mechanics, ordering, and the merge commands. These rules are the
supervisor's own:

- **Merge the whole stack at once.** Use `--merge`, so one command lands every ready layer. Drain
  with `--merge-ready` only when the layers above will clearly take longer than the ready lower
  layers (a requested change or open `TRIAGE`, a pending human review, a blocker, or CI far longer
  than the wait so far), and state why in the report. A layer a poll or a ready-delay away is not a
  reason.
- **Gate every layer.** Each layer a merge would land passes step 5 on its own current head. When
  one layer does not, none of the layers above it merge.
- **Merge only what this run reviewed.** Never shepherd or merge a layer the merge authority does
  not cover. Report such layers with their number and state.
- **Derive the ledger.** Which stacks and layers exist, their order, and their state are read from
  the forge every sweep (the `pr-shepherd stack` result, the stack list endpoint), never cached.
  Reconcile unfiltered before opening or adding to a stack, so a new session does not start a rival
  one. `state.json` holds intent only.
- **Layer cap.** An agent building a stack keeps at most `layerCap` open layers (default 10),
  counting every locally tracked layer not yet submitted. Beyond the cap, independent work opens as
  its own PR on the default branch and dependent work waits for the bottom layers to merge.
- **Escalate per layer.** A layer that needs a human gets the `labels.needsHuman` label (skipping
  the label without creating it and noting it missing in the summary when `labels.needsHuman` does
  not exist in that repository) and one comment per escalation event, with its position in the stack
  and what it needs.
