import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyGh, policy, PR, tempDir } from './helpers/classify.js'
import { writePolicyConfig } from './helpers/mcp.js'
import { policyDir } from './helpers/pull.js'

describe('supervisor policy classify-prepare, with no --dir', () => {
  it('reads the policy directory from the supervisor config, as policy check does', async () => {
    const config = await writePolicyConfig(await tempDir(), 'config.json', {
      policy: policyDir('classify-flake-fix'),
      requiredAlwaysHuman: [],
    })
    const result = await policy(
      ['classify-prepare', ...PR, '--out', await tempDir()],
      classifyGh().run,
      { SUPERVISOR_CONFIG: config },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).classifiers.map((c: { name: string }) => c.name)).toEqual([
      'flake_fix',
    ])
  })

  it('lets --dir win over the config', async () => {
    const config = await writePolicyConfig(await tempDir(), 'config.json', {
      policy: join(await tempDir(), 'none'),
    })
    const result = await policy(
      [
        'classify-prepare',
        ...PR,
        '--dir',
        policyDir('classify-flake-fix'),
        '--out',
        await tempDir(),
      ],
      classifyGh().run,
      { SUPERVISOR_CONFIG: config },
    )
    expect(result.code).toBe(0)
  })

  it('says to pass --dir when neither the flag nor the config gives a directory', async () => {
    const gh = classifyGh()
    const result = await policy(['classify-prepare', ...PR, '--out', await tempDir()], gh.run, {
      SUPERVISOR_CONFIG: join(await tempDir(), 'missing.json'),
    })
    expect(result.code).toBe(2)
    expect(gh.calls).toEqual([])
  })
})
