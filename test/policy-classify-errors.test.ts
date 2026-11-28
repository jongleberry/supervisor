import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyGh, policy, PR, tempDir } from './helpers/classify.js'
import { HEAD, OLD_HEAD, policyDir } from './helpers/pull.js'

const DIR = policyDir('classify-flake-fix')
const PREPARE = (out: string) => ['classify-prepare', ...PR, '--dir', DIR, '--out', out]

describe('supervisor policy classify-prepare, when it cannot go on', () => {
  it('writes no input and reads no diff when no policy names a repo classifier', async () => {
    const out = await tempDir()
    const gh = classifyGh({ diffCode: 1 })
    const result = await policy(
      ['classify-prepare', ...PR, '--dir', policyDir('pull-facts'), '--out', out],
      gh.run,
    )
    expect(JSON.parse(result.stdout).classifiers).toEqual([])
    expect(gh.calls.some((args) => args.includes('Accept: application/vnd.github.diff'))).toBe(
      false,
    )
  })

  it('fails when the diff is too large, empty, or the head moves while it is read', async () => {
    const run = async (options: Parameters<typeof classifyGh>[0]) =>
      policy(PREPARE(await tempDir()), classifyGh(options).run)
    const large = await run({ diffCode: 1 })
    expect(large.code).toBe(2)
    expect(large.stderr).toContain('too large')
    expect(large.stdout).toBe('')
    expect((await run({ diff: '\n' })).stderr).toContain('no diff')
    expect((await run({ heads: [HEAD, OLD_HEAD] })).stderr).toContain('got a new head')
  })

  it('reports usage errors', async () => {
    const gh = classifyGh()
    const out = await tempDir()
    for (const args of [
      ['classify-prepare', '--dir', DIR],
      ['classify-prepare', '--out', out, '--dir', DIR, '--bogus'],
      ['classify-prepare', '--out', out, '--dir', DIR],
      ['classify-prepare', '--out', out, '--dir', DIR, 'a/b', '7', 'extra'],
      ['classify-prepare', '--out', out, '--dir', DIR, '../x', '7'],
      ['classify-prepare', '--out', out, '--dir', DIR, 'a/b', '0'],
    ]) {
      const result = await policy(args, gh.run)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('Usage:')
    }
    expect(gh.calls).toEqual([])
  })

  it('reports a policy directory it cannot read', async () => {
    const result = await policy(
      ['classify-prepare', ...PR, '--dir', join(await tempDir(), 'none'), '--out', await tempDir()],
      classifyGh().run,
    )
    expect(result.code).toBe(2)
  })
})
