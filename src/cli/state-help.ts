import { STOPPED_EXIT } from '../state/stop.js'
import { FIELDS } from '../state/schema.js'

const FIELD_NAMES = Object.keys(FIELDS)
const FIELD_LINES = [0, 6, 12, 18]
  .map((start) => `  ${FIELD_NAMES.slice(start, start + 6).join(', ')}`)
  .join(',\n')

export const STATE_HELP = `Usage: supervisor state <subcommand> [options]

Typed, locked, atomic updates to <stateDir>/state.json. The config file is $SUPERVISOR_CONFIG,
else .supervisor.json in the current directory. Each subcommand holds the state lock for its whole
read-modify-write, checks the shape of the fields it touches, and replaces the file atomically.

While the stop switch is set (see: supervisor stop --help), sweep-start and merge-record refuse
with one line and exit ${STOPPED_EXIT}. Every other subcommand only records facts and keeps working.

Subcommands:
  show [key]                              Print one key, or the top-level keys
  set <path> --json <value>               Set a path under a known field to a JSON value
  append <path> --json <value> [--keep <n>]
                                          Append a JSON value to the list at a path;
                                          --keep keeps only the newest n entries
  remove <path>                           Remove the key at a path
                                          (set and append refuse mergeRecords: use merge-record)
  sweep-start --id <id> [--ttl-minutes <n>]
                                          Claim the one running sweep; exits 1 while another id's
                                          claim is newer than the limit (default 120 minutes), and
                                          ${STOPPED_EXIT} while the stop switch is set
  sweep-done                              Set lastSweepAt to now and release the sweep claim
  merge-record --pr <owner/repo#N> --head <sha> --check <file>
               --review <text> --always-human <text>
                                          Record one autonomous merge before it is made. <sha> is
                                          the full head commit, --check the JSON that
                                          "supervisor policy check <owner>/<repo> <N> --json"
                                          printed, --review who reviewed the head and the outcome,
                                          --always-human who checked the always-human list. Exits
                                          1 unless the check is of that pull request at that head
                                          (one made with --input is refused) and its next step is
                                          merge with no blocker, pr-shepherd ready to merge the head, and no
                                          author-only warning; ${STOPPED_EXIT} while the stop switch is set
  merge-records [--repo <owner/repo>] [--rule <text>]
                                          Print the merge records, one JSON line each: all, or
                                          those of one repository, or those with a rule whose
                                          purpose contains <text> (takes no lock)
  advance-hh                              Store the cursor and seen ids from hh-last.json under
                                          hookHarness (a 0.3.0 per-owner entry is dropped and its
                                          seen ids kept)
  route --what <text> --to <text> [--evidence <text>] [--issue <text>] [--note <text>]
                                          Record where an item was routed
  annotate-route --match <text> --note <text> [--issue <text>]
                                          Annotate the one routed item whose "what" contains <text>
  sp-record --prompt <name> --run-id <id> --outcome <text> --lap <n> --next <name> [--pr <ref>]
                                          Record a scheduled-prompt run (with its rotation lap)
                                          and the next prompt
  sp-next --next <name>                   Set the next scheduled prompt
  reviewed [--file <path>] [--prune-before <ISO time>]
                                          Add harvested comment ids from a
                                          {"<owner>/<repo>": [ids]} JSON file, and/or drop
                                          entries harvested before the time (give at least one)
  watch add --id <id> --notify <session> --pr <owner/repo#N> [--pr ...] [--note <text>]
                                          Add a merge watch; supervisor wait reports it when
                                          every pull request has merged
  watch list | watch ack --id <id> | watch remove --id <id>
                                          List the watches, acknowledge one, or remove one
  late-review <owner/repo#N>...           Report unresolved threads and late reviews for merged
                                          pull requests (takes no lock; exits 1 on any error)
  update-check-script --repo <name>[:<ecosystem>,...] [--repo ...] [--owner <owner>] [--dry]
                                          Print the dependency update-check browser script
                                          (takes no lock; --owner defaults to the only scope owner)

Fields (the first key of every <path>):
${FIELD_LINES}

Each field a write adds or changes is checked against schemas/state.json before the write, and a
write that breaks it is refused, so a field with a required shape is set in one command, not key
by key:
  supervisor state set schedule --json '{"id":"job-1","registeredAt":"2026-01-01T00:00:00Z","cron":"0 */6 * * *","expiresAt":"2026-01-08T00:00:00Z"}'
Reading never checks the file, and a field a write leaves alone is never checked: an old file with a
bad field can be shown, does not block writes to other fields, and stays until it is rewritten.

A <path> is its keys as separate arguments, or as one argument joined by dots:
  supervisor state set lateReview example-org/example-repo --json '{}'
  supervisor state set hookHarness.cursor --json '"c1"'
Separate arguments are never split, so a key given that way can contain a dot. A key that names a
repository is <owner>/<repo>, and a repository name can contain a dot, so a dotted path that goes
on after such a key is refused (exit 1) instead of being split in the wrong place. Give those
paths as separate arguments:
  supervisor state set lateReview example-org/example.js scannedThrough --json '"2026-01-01T00:00:00Z"'

Options:
  -h, --help                              Show help
`
