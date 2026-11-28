import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupLoops, makeLoop, NOW } from './helpers/loop.js'

describe('supervisor state record subcommands', () => {
  afterEach(cleanupLoops)

  it('records a route with only the optional fields that were given', async () => {
    const loop = await makeLoop()
    const plain = await loop.cli(['state', 'route', '--what', 'flaky test', '--to', 'worker'])
    expect(plain.stdout).toBe(`{"what": "flaky test", "to": "worker", "at": "${NOW}"}\n`)
    const full = ['--evidence', 'run 7', '--issue', 'example-org/example-repo#3', '--note', 'n']
    await loop.cli(['state', 'route', '--what', 'slow job', '--to', 'agent', ...full])
    expect((await loop.state()).routed[1]).toEqual({
      what: 'slow job',
      to: 'agent',
      at: NOW,
      evidence: 'run 7',
      issue: 'example-org/example-repo#3',
      note: 'n',
    })
    expect((await loop.cli(['state', 'route', '--what', 'x'])).code).toBe(2)
    expect((await loop.cli(['state', 'route', '--to', 'x'])).stderr).toContain('--what is required')
    expect((await loop.cli(['state', 'route', '--bogus'])).code).toBe(2)
  })

  it('annotates the one route that matches and refuses none or several', async () => {
    const loop = await makeLoop()
    expect(
      (await loop.cli(['state', 'annotate-route', '--match', 'x', '--note', 'n'])).stderr,
    ).toBe("annotate-route: 0 entries match 'x'; need exactly 1\n")
    await loop.seed({
      routed: [{ what: 'flaky test' }, { what: 'flaky build' }, 'junk', { to: 1 }],
    })
    const several = await loop.cli(['state', 'annotate-route', '--match', 'flaky', '--note', 'n'])
    expect(several).toMatchObject({ code: 1, stderr: expect.stringContaining('2 entries match') })
    const one = await loop.cli(['state', 'annotate-route', '--match', 'build', '--note', 'fixed'])
    expect(one.stdout).toBe('{"what": "flaky build", "note": "fixed"}\n')
    await loop.cli(['state', 'annotate-route', '--match', 'test', '--note', 'n', '--issue', 'i#1'])
    expect((await loop.state()).routed[0]).toEqual({ what: 'flaky test', note: 'n', issue: 'i#1' })
  })

  it('marks a sweep done', async () => {
    const loop = await makeLoop()
    expect((await loop.cli(['state', 'sweep-done'])).stdout).toBe(`{"lastSweepAt": "${NOW}"}\n`)
    expect((await loop.state()).lastSweepAt).toBe(NOW)
    expect((await loop.cli(['state', 'sweep-done', 'extra'])).code).toBe(2)
  })

  it('lets one sweep run at a time and frees the claim when it is done or too old', async () => {
    const loop = await makeLoop()
    const start = (id: string, ...rest: string[]) =>
      loop.cli(['state', 'sweep-start', '--id', id, ...rest])
    expect((await start('a')).stdout).toBe(`{"sweep": {"id": "a", "startedAt": "${NOW}"}}\n`)
    expect((await start('a')).code).toBe(0)
    const refused = await start('b')
    expect(refused.code).toBe(1)
    expect((await loop.state()).sweep.id).toBe('a')

    await loop.cli(['state', 'sweep-done'])
    expect((await loop.state()).sweep).toBeUndefined()
    expect((await start('b')).code).toBe(0)

    const later = () => new Date(Date.parse(NOW) + 121 * 60_000)
    expect((await loop.cli(['state', 'sweep-start', '--id', 'c'], undefined, later)).code).toBe(0)
    expect((await loop.state()).sweep.id).toBe('c')

    await loop.seed({ sweep: { id: 'old' } })
    expect((await start('d')).code).toBe(0)
    expect((await start('e', '--ttl-minutes', '0')).code).toBe(2)
    expect((await start('e', '--ttl-minutes', 'x')).code).toBe(2)
    expect((await loop.cli(['state', 'sweep-start'])).code).toBe(2)
  })

  it('adds harvested comment ids per owner/repo once, whatever form they were stored in', async () => {
    const loop = await makeLoop()
    const file = join(loop.stateDir, '..', 'harvest.json')
    await loop.seed({ reviewedComments: { 'example-org/example-repo': [7, { id: '8' }] } })
    await writeFile(file, '{"example-org/example-repo": [7, "8", 9, 9], "example-user/other": [1]}')
    const added = await loop.cli(['state', 'reviewed', '--file', file])
    expect(added.stdout).toBe('{"example-org/example-repo": 3, "example-user/other": 1}\n')
    expect((await loop.state()).reviewedComments['example-org/example-repo'][2]).toEqual({
      id: 9,
      harvestedAt: NOW,
    })
  })

  it('refuses a harvest file keyed by a bare repository name or holding a non-id', async () => {
    const loop = await makeLoop()
    const file = join(loop.stateDir, '..', 'harvest.json')
    const reviewed = async (content: string) => {
      await writeFile(file, content)
      return (await loop.cli(['state', 'reviewed', '--file', file])).stderr
    }
    expect(await reviewed('{"example-repo": [1]}')).toBe(
      "reviewed: 'example-repo' must look like owner/repo\n",
    )
    expect(await reviewed('{"example-org/example-repo": ["abc"]}')).toContain('is not a comment id')
    expect(await reviewed('{"example-org/example-repo": [null]}')).toContain('is not a comment id')
    expect(await reviewed('{"example-org/example-repo": 5}')).toContain('must be array, got number')
    expect(await reviewed('[]')).toBe('state.json: reviewed --file must be object, got array\n')
    expect(await reviewed('{nope')).toContain(file)
    expect(await loop.cli(['state', 'reviewed', '--file', `${file}.missing`])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ENOENT'),
    })
  })

  it('prunes entries harvested before a time, keeping newer and unreadable ones', async () => {
    const loop = await makeLoop()
    const old = '2026-01-01T00:00:00Z'
    await loop.seed({
      reviewedComments: {
        'example-org/example-repo': [
          { id: 1, harvestedAt: old },
          { id: 2, harvestedAt: '2026-03-01T00:00:00Z' },
          { id: 3 },
          { id: 4, harvestedAt: 5 },
          7,
        ],
        'example-org/empty': [{ id: 5, harvestedAt: old }],
      },
    })
    const pruned = await loop.cli(['state', 'reviewed', '--prune-before', '2026-02-01T00:00:00Z'])
    expect(pruned.stdout).toBe('{"example-org/example-repo": 4, "example-org/empty": 0}\n')
    const kept = (await loop.state()).reviewedComments['example-org/example-repo']
    const ids = kept.map((entry: { id: number } | number) =>
      typeof entry === 'number' ? entry : entry.id,
    )
    expect(ids).toEqual([2, 3, 4, 7])
  })

  it('adds and prunes in one call, and refuses a bad time or no option', async () => {
    const loop = await makeLoop()
    const file = join(loop.stateDir, '..', 'harvest.json')
    await writeFile(file, '{"example-org/example-repo": [1]}')
    const both = await loop.cli([
      'state',
      'reviewed',
      '--file',
      file,
      '--prune-before',
      '2000-01-01T00:00:00Z',
    ])
    expect(both.stdout).toBe('{"example-org/example-repo": 1}\n')
    expect(await loop.cli(['state', 'reviewed', '--prune-before', 'soon'])).toMatchObject({
      code: 1,
      stderr: "reviewed: --prune-before 'soon' is not a time\n",
    })
    for (const impossible of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', 'Feb 1 2026']) {
      expect((await loop.cli(['state', 'reviewed', '--prune-before', impossible])).code).toBe(1)
    }
    expect((await loop.cli(['state', 'reviewed', '--prune-before', '2024-02-29'])).code).toBe(0)
    expect((await loop.cli(['state', 'reviewed'])).code).toBe(2)
  })
})
