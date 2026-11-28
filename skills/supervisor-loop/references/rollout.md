# Staged rollout to enforce mode

Move an installation from `report` mode to `enforce` mode gradually rather than switching every
scope at once. Only the user edits the configuration file.

## Order

1. **Start every scope in `report` mode.** Run at least one full sweep and review the report-mode
   summary so you know the volume of pending late reviews, untriaged issues, and flakes.
2. **Switch one scope at a time, smallest first.** Pick the scope with the fewest repositories and
   lowest activity first. Wait for at least one clean `enforce` sweep (and healthy event handling
   when `eventWait` is configured) before switching the next scope.

## Pre-switch preflight

In `report` mode, preflight skips dispatch targets and labels because nothing is dispatched or
labeled there. Before changing a scope `<owner>` from `report` to `enforce`, run both checks as if
that scope were already in `enforce` mode:

1. **Labels and loop checks:** run
   `supervisor preflight --enforce-scope <owner> --json` as its own command. This verifies that the
   configured `labels.needsHuman` exists in every selected repository of `<owner>` (alongside
   `supervisor`, `config`, `gh`, `pr-shepherd`, `hook-harness`, and `stop`).
   - Missing labels are reported in the `labels` check detail (`missing: ...`) without making
     `supervisor preflight` exit 1, so inspect the `labels` detail line even when the command exits 0. Report the exact `<owner>/<repo>` and label name to the user; creating a label is left to a
     person and the supervisor never creates labels.
   - Missing `labels.needsHuman` does not block switching if the user accepts it: escalation still
     happens without the label, and the summary notes that the label was missing. No dispatch is
     held back for a missing label.
2. **Dispatch targets:** when `dispatchTargets` is configured, run its read-only check as its own
   standalone command (never chained with `&&` or pipes). This often talks to a local socket (for
   example `herdr agent list`) and may fail inside a harness sandbox with `EPERM`.
3. **Approve harness prompts before the switch:** have the user approve any harness permission
   prompt surfaced by step 1 or step 2 (such as running `herdr` outside the sandbox) before editing
   the config to `mode: "enforce"`. Otherwise the first enforce sweep would silently fall back to
   isolated worktree workers alone or stall on a prompt. Never work around a harness refusal.

## First enforce sweep

A scope leaving `report` mode often carries accumulated work (late-review candidates, untriaged
issues, open flakes). The per-sweep [`sweepCap`](config.md#other-keys) (`issues`, default `10`;
`dispatches`, default `5`) bounds each pass so that backlog drains across sweeps rather than in one
burst:

- Work over either cap waits for the next sweep and never expires (see
  [Per-sweep cap](../../supervisor-sweep/SKILL.md#rules-for-every-phase)).
- The Phase H summary reports how many new issues and how many dispatches were held back.
- Cursors (`lateReview.<owner>/<repo>`, `retroCursor`, `commandsThrough`, `scheduledPrompts.next`)
  and completion records (`handledFailures`, `intake` removals, `/fix` reactions) advance only past
  the work that was actually done.

For an extra-cautious first pass, the user may temporarily lower `sweepCap` (even to `0` for issues
or dispatches) or run a narrowed pass (`--owner <owner>`, `--repo <owner>/<repo>`, or `--phase`).
