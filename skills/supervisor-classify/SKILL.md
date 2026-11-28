---
name: supervisor-classify
description: Use when a merge policy names a repo/<name> classifier or claude/code_review and `supervisor policy check` needs their results for one pull request head. Prepares one input per repo/<name> classifier, has a fresh narrow subagent answer each, maps the final review of that head to claude/code_review, checks the answers, and writes the file for `--classifiers`.
---

# Supervisor: classify a pull request head

Get the `repo/<name>` and `claude/code_review` classifier results for one PR head. The supervisor
session never answers a classifier itself: a fresh `supervisor-classifier` subagent answers each
`repo/<name>` classifier from one question and one diff alone, and `classify-collect` maps the
final review of that head to `claude/code_review`.

1. **Prepare.** Run
   `supervisor policy classify-prepare <owner>/<repo> <N> [--dir <policy dir>] --out <out dir>` with
   the same `--dir`, `--supervisor-policy` and `--repo-dir` the policy check will use. With no
   `--dir` it resolves the policy from the supervisor config, as the check does. Use a fresh
   `<out dir>`. It prints the manifest: the PR head, whether the policy names `claude/code_review`,
   and for each `repo/<name>` classifier, its `input` file, its `answer` path and its `model`. A
   classifier with an `error` has no input and no result; go on without it. If the command fails,
   for example because the diff is too large, there are no results: run the check without
   `--classifiers`.
2. **Answer.** For each classifier with an `input`, spawn one fresh `supervisor-classifier`
   subagent. Its whole prompt is the path of the `input` file. Use the classifier's `model` when
   the harness can select it. Write the reply, byte for byte, to the `answer` path with a
   file-writing tool. When `classifiers` is empty (for example, when the policy names only
   `claude/code_review`), skip straight to step 3.
3. **Collect.** Run `supervisor policy classify-collect --out <out dir>` (add
   `--reviewer <account>` if `finalReview.reviewer` is not set in the supervisor config). It checks
   each `repo/<name>` answer, maps the newest final review of the head by the trusted reviewer to
   `claude/code_review` when the policy names it, and prints the path of `classifiers.json`. It
   leaves out any answer or review that is missing, skipped, dismissed, untrusted, or not allowed,
   and exits 1 and writes nothing when the PR has a new head since step 1: start again from step 1.
4. **Check.** Pass that file to `supervisor policy check ... --classifiers <classifiers.json>`. The
   file names the head it was collected for. The check exits 2 when the PR has a newer head: start
   again from step 1.

## Rules

- Never answer a classifier in this session, or from what you already know about the PR.
- Never write a `claude/code_review` result by hand; let `classify-collect` map the trusted
  reviewer's final review of the head.
- The subagent's prompt is the input path only: no PR number, title, body, policy, or mention of a
  merge. Spawn one subagent per classifier, never one for several.
- Never edit, fix or reinterpret a reply. Never run a classifier again to get a different answer.
  The one exception is a reply that was not parseable JSON: run that classifier once more.
- Never copy a value from a PR body, comment or commit message.
- Where the harness has no named agents, spawn a generic fresh subagent with the body of
  [supervisor-classifier](../../agents/supervisor-classifier.md) as its instructions, allowed to
  read files only.
