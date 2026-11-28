# Phase E - Journal distill

Agents write journal entries with agent-blackboard's own MCP tools, against a schema registered on
its server. This phase turns those entries into follow-ups with agent-blackboard's own distill skill
and tools, without wrapping them. How agent-blackboard exports, partitions, or bounds sessions
belongs to agent-blackboard, not this skill.

Confirm `distill.retroDays` and `distill.sessionDays` are configured before running; stop and ask
when either is missing.

## Enforce scope

Once per scope:

1. Distill the sessions completed after `retroCursor` whose entries name that scope's repositories,
   using the configured `distill.retroDays` and `distill.sessionDays`.
2. File the verified follow-ups through the `github-issue` skill, each in the repository it
   concerns, up to the sweep's remaining `sweepCap.issues` budget (see
   [Per-sweep cap](../SKILL.md#rules-for-every-phase)). A finding about a private repository stays
   in that repository. If `sweepCap.issues` is reached, stop filing and report how many verified
   follow-ups were held back for the next sweep.
3. Archive only the sessions whose follow-ups were all filed (and only when `distill.archive` is
   true); do not archive sessions with held-back follow-ups. Either way, remove the local snapshot
   and its partitions in cleanup.
4. When Phase E succeeds for a scope that had a recorded Phase E blocker in `escalations`, remove
   that resolved key (`supervisor state remove escalations <key>`).
5. Advance `retroCursor` only after that clean-up succeeds for every selected scope with no
   held-back follow-ups, and never while any selected scope is in `report` mode, failed Phase E, or
   ran under `--dry-run`.

## When the distill cannot run

The distill can fail before inspection — for example when partitioning refuses a session that
exceeds the partition size bound, when export or manifest/checksum verification fails, or when a
pending worktree outbox blocks export. Follow the distill skill's boundaries: never split a session
group, never raise or weaken its partition bounds, and never fall back to reading raw session
entries directly.

Instead:

1. Remove any local snapshot (and any partitions) created before the failure, so private records are
   not left on disk.
2. Record the failure reason as one summary line for Phase E (with the scope's owner, repository or
   scope, phase `E`, action `escalated` — prefixed with `would` in a `report` scope — and the
   reason).
3. In an `enforce` scope (never on `--dry-run`), send one notification through `escalationChannel`
   deduped on `escalations`, keyed by phase, scope owner, and blocker — for example
   `phase-e:<owner>:<sessionId>` when one session blocks partitioning, or `phase-e:<owner>:<reason>`
   for a scope-level blocker — using
   `supervisor state set escalations <key> --json '"<ISO time>"'`. On later sweeps while the same
   key is still recorded, keep the one summary line and send no repeat notification. In a `report`
   scope, keep the escalation as a summary line only and write nothing to `escalations`, so a later
   switch to `enforce` still notifies once.
4. Archive nothing and do not advance `retroCursor`.
5. Keep the other phases (and other scopes) running.

## Report scope

In a `report` scope nothing is filed and nothing is archived, so inspecting every partition of a
large snapshot on every sweep wastes quota for a summary alone. Follow the same model as
[Phase F](late-reviews.md) in `report` mode:

1. Export, verify, and partition the snapshot for the scope as usual. If that fails, follow
   [When the distill cannot run](#when-the-distill-cannot-run) above.
2. Run the structural classification (`distill classify` with the shared cutoffs from
   `distill.retroDays` and `distill.sessionDays`) across the scope's partitions and report the
   structural counts in the summary: eligible stale sessions by
   shape (checkpoint-only, journal-only, zero-entry child, zero-entry root), not-yet-eligible
   sessions, and entry-type-unresolved sessions.
3. Hand-read and verify against the default branch only a bounded sample: at most 5 eligible
   journal sessions per scope, newest first. Hand read-only inspectors only
   the partition(s) that hold those sampled sessions (never the raw snapshot) and instruct them to
   hand-read only those sampled session IDs.
4. List the verified follow-ups that would be filed in the summary, labeled as a sample alongside the
   full structural counts.
5. File nothing, archive nothing, and do not advance `retroCursor`: a later switch to `enforce` must
   still distill and file what the snapshot held. Still remove the local snapshot and its partitions
   in cleanup.
