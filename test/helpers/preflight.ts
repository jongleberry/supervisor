import { MIN_CLI_VERSION } from '../../src/cli/version.js'
import type { ProcessResult, RunProcess } from '../../src/state/process.js'
import { done } from './loop.js'

export interface Calls {
  run: RunProcess
  seen: string[]
}

export type Reply = ProcessResult | Error | ((args: string[]) => ProcessResult | Error)

export interface PreflightReplies {
  supervisor?: Reply
  gh?: Reply
  ghUser?: Reply
  ghRepos?: Reply
  ghGraphql?: Reply
  'pr-shepherd'?: Reply
}

const DEFAULT_GRAPHQL = done(
  JSON.stringify({
    data: {
      r0: { needsHuman: { name: 'needs-human' } },
    },
  }),
)

function pickReply(replies: PreflightReplies, command: string, args: string[]): Reply | undefined {
  if (command === 'gh' && args[0] === 'api') {
    if (args[1] === 'user') return replies.ghUser
    if (args[1] === 'graphql') return replies.ghGraphql
    return replies.ghRepos
  }
  return replies[command as keyof PreflightReplies]
}

/** A runner that answers by command/gh subcommand and records each call; an Error is thrown. */
export function fake(replies: PreflightReplies): Calls {
  const seen: string[] = []
  const run: RunProcess = async (command, args) => {
    seen.push([command, ...args].join(' '))
    const chosen = pickReply(replies, command, args)
    const reply = typeof chosen === 'function' ? chosen(args) : (chosen ?? done('', 1, 'no reply'))
    if (reply instanceof Error) {
      throw reply
    }
    return reply
  }
  return { run, seen }
}

export const GOOD: PreflightReplies = {
  supervisor: done(`${MIN_CLI_VERSION}\n`),
  gh: done("Logged in\n  - Token scopes: 'repo', 'read:org'\n"),
  ghUser: done('example-user\n'),
  ghRepos: done('example-repo\tfalse\n'),
  ghGraphql: DEFAULT_GRAPHQL,
  'pr-shepherd': done('pr-shepherd 1.2.3\n'),
}
