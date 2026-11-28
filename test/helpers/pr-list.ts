import { runCli, type CliIo } from '../../src/cli/run.js'
import type { RunProcess } from '../../src/state/process.js'

export const REPO = 'example-org/example-repo'

export interface PullNodeInput {
  number: number
  title: string
  isDraft?: boolean
  comments: string[]
  hasNextComments?: boolean
  commentsEndCursor?: string | null
}

export function makePullNode(input: PullNodeInput) {
  return {
    number: input.number,
    title: input.title,
    url: `https://github.com/${REPO}/pull/${input.number}`,
    isDraft: input.isDraft ?? false,
    comments: {
      pageInfo: {
        hasNextPage: input.hasNextComments ?? false,
        endCursor: input.commentsEndCursor ?? null,
      },
      nodes: input.comments.map((body) => ({ body })),
    },
  }
}

export async function runPrCli(args: string[], runProcess: RunProcess) {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    env: {},
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    startMcp: async () => undefined,
    runProcess,
    shepherdStatus: async () => {
      throw new Error('unexpected pr-shepherd call')
    },
    now: () => new Date(0),
  }
  const code = await runCli(args, io)
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}
