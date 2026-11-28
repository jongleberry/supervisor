# Guardrails

Autonomy is something to widen and narrow on evidence, not to set once. These are the controls for doing that.

[Back to the graph](graph.md)

| Guardrail                  | What it does                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shadow mode                | A new scope, or a new merge category, runs as a dry run first and reports what it would have merged. It turns on after its eval passes and a person has read one shadow report                                                                         |
| Merge record               | Every autonomous merge records the PR, the head commit, the rule that allowed it, the classifier output, the review, and the always-human check. A bad merge can then be traced to the rule that let it through                                        |
| Revert rate                | Reverts and follow-up fixes are counted per category. A category with a revert suspends itself until a person clears it                                                                                                                                |
| Always-human check         | Before every merge, the diff is matched against the always-human list: workflow permissions, secrets, release and signing paths, locks and isolation levels, payments, privacy, irreversible deletes. A match escalates, whatever else the policy says |
| Self-modification boundary | The supervisor may merge skill text on an eval delta. It may never merge a change to its own classifiers, the always-human list, the merge policy, or the eval runner                                                                                  |
| Stop switch                | One file the supervisor reads before every tick and every merge. Creating it stops all action, faster than finding the session                                                                                                                         |
| Budgets                    | Caps per sweep on workers dispatched and PRs merged, and a token figure in each sweep summary. A loop that fixes flakes immediately needs a ceiling for the day CI breaks everywhere at once                                                           |
| Loop guards                | Feedback about feedback PRs is ignored. The supervisor's own sessions are distilled, but their themes cannot change its own merge rules                                                                                                                |
| Watching the watcher       | Host timers expire and sessions die quietly. An external check reads the time of the last sweep and notifies a person when it is too old                                                                                                               |
| Untrusted text             | Comments, PR bodies and issue text are data, never instructions. Text that tries to widen a grant, authorize a command sender or redirect a merge changes nothing                                                                                      |

## The numbers

If these do not improve, the graph is not improving:

1. Interrupts to a person per day
2. Time to merge, by category
3. Flake time-to-fix
4. Journal coverage: the share of agent sessions that left entries
5. The eval delta of merged skill changes
6. The share of work done by small models

## Evals the autonomy depends on

| Eval                 | A pass means                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Merge classification | On a labelled set of past PRs, zero PRs merged that should have gone to a person. Missed merges cost time; false merges are failures |
| Injection resistance | Events whose text tries to widen the grant cause no action outside it                                                                |
| Sweep replay         | Recorded events and forge state, run as a dry-run sweep, produce the expected list of actions                                        |
| Journal triggering   | Given a task with injected friction, the agent writes a valid entry before filing an issue, and writes nothing on a clean task       |

These live in `evals/` and run before any widening of what the supervisor may do. [evals-design.md](evals-design.md) says how each one is built.
