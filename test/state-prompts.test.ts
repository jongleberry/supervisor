import { afterEach, describe, expect, it } from 'vitest'
import { cleanupLoops, makeLoop, NOW } from './helpers/loop.js'

const sampleRun = (index: number, lap = 1) => ({
  prompt: `example-org/example-repo:prompts/p-${index}.md`,
  runId: `run-${index}`,
  at: NOW,
  outcome: 'verified no-op',
  lap,
})

describe('supervisor state scheduled-prompt subcommands', () => {
  afterEach(cleanupLoops)

  it('records scheduled-prompt runs with lap, bounded by the configured history', async () => {
    const loop = await makeLoop({ scheduledPrompts: { history: 2 } })
    const record = (prompt: string, lap: string, extra: string[] = []) =>
      loop.cli([
        'state',
        'sp-record',
        ...extra,
        '--prompt',
        prompt,
        '--run-id',
        `run-${prompt}`,
        '--outcome',
        'draft PR',
        '--lap',
        lap,
        '--next',
        'b',
      ])
    expect((await record('a', '1')).stdout).toBe(
      `{"recorded": {"prompt": "a", "runId": "run-a", "at": "${NOW}", "outcome": "draft PR", "lap": 1}, "next": "b"}\n`,
    )
    await record('b', '2', ['--pr', 'example-org/example-repo#9'])
    await record('c', '2')
    const { scheduledPrompts } = await loop.state()
    expect(
      scheduledPrompts.runs.map((run: { prompt: string; lap: number }) => [run.prompt, run.lap]),
    ).toEqual([
      ['b', 2],
      ['c', 2],
    ])
    expect(scheduledPrompts.runs[0].pr).toBe('example-org/example-repo#9')
    expect((await loop.cli(['state', 'sp-next', '--next', 'z'])).stdout).toBe('{"next": "z"}\n')
    expect((await loop.state()).scheduledPrompts.next).toBe('z')
  })

  it('keeps twenty scheduled-prompt runs when the config sets no history', async () => {
    const loop = await makeLoop({ scheduledPrompts: undefined })
    await loop.seed({
      scheduledPrompts: { runs: Array.from({ length: 25 }, (_, i) => sampleRun(i)) },
    })
    const args = [
      '--prompt',
      'a',
      '--run-id',
      'r',
      '--outcome',
      'none',
      '--lap',
      '2',
      '--next',
      'a',
    ]
    expect((await loop.cli(['state', 'sp-record', ...args])).code).toBe(0)
    const { runs } = (await loop.state()).scheduledPrompts
    expect(runs).toHaveLength(20)
    expect(runs.at(-1)).toMatchObject({ prompt: 'a', lap: 2 })
  })

  it('refuses sp-record when --lap is missing or not a positive safe integer', async () => {
    const loop = await makeLoop()
    const base = [
      'state',
      'sp-record',
      '--prompt',
      'a',
      '--run-id',
      'r',
      '--outcome',
      'ok',
      '--next',
      'b',
    ]
    const missing = await loop.cli(base)
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('--lap is required')
    for (const bad of ['0', '-1', '1.5', '01', '', 'abc', '99999999999999999999']) {
      const result = await loop.cli([...base, `--lap=${bad}`])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`--lap must be a positive integer, got '${bad}'`)
    }
  })

  it('drops pre-lap legacy runs on sp-record and sp-next while rejecting malformed entries', async () => {
    const loop = await makeLoop()
    const legacy = { prompt: 'old', runId: 'r0', at: NOW, outcome: 'draft PR' }
    await loop.seed({ scheduledPrompts: { next: 'old', runs: [legacy, sampleRun(1, 1)] } })
    const nextOnly = await loop.cli(['state', 'sp-next', '--next', 'b'])
    expect(nextOnly.code).toBe(0)
    expect((await loop.state()).scheduledPrompts).toEqual({
      next: 'b',
      runs: [sampleRun(1, 1)],
    })

    await loop.seed({ scheduledPrompts: { next: 'old', runs: [legacy] } })
    const rec = await loop.cli([
      'state',
      'sp-record',
      '--prompt',
      'a',
      '--run-id',
      'r1',
      '--outcome',
      'verified no-op',
      '--lap',
      '1',
      '--next',
      'b',
    ])
    expect(rec.code).toBe(0)
    expect((await loop.state()).scheduledPrompts.runs).toEqual([
      { prompt: 'a', runId: 'r1', at: NOW, outcome: 'verified no-op', lap: 1 },
    ])

    await loop.seed({ scheduledPrompts: { runs: [{ ...legacy, lap: 0 }] } })
    const badLap = await loop.cli(['state', 'sp-next', '--next', 'c'])
    expect(badLap.code).toBe(1)
    expect(badLap.stderr).toContain('scheduledPrompts.runs.0.lap must be >= 1')

    await loop.seed({ scheduledPrompts: { runs: ['not-an-object'] } })
    const notObj = await loop.cli(['state', 'sp-next', '--next', 'c'])
    expect(notObj.code).toBe(1)
    expect(notObj.stderr).toContain('scheduledPrompts.runs.0 must be object')
  })

  it('allows sp-next without creating runs when none exist', async () => {
    const loop = await makeLoop()
    expect((await loop.cli(['state', 'sp-next', '--next', 'a'])).code).toBe(0)
    expect((await loop.state()).scheduledPrompts).toEqual({ next: 'a' })
  })

  it('refuses to load a config whose scheduledPrompts.history is smaller than quota', async () => {
    const loop = await makeLoop({ scheduledPrompts: { quota: 4, history: 2 } })
    const result = await loop.cli(['state', 'show'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('/scheduledPrompts/history: must be >= quota (4), got 2')
  })
})
