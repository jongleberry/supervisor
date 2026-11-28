import { ConfigError } from '../config/load.js'
import {
  resolvePolicyFromConfig,
  type PolicyConfigOverrides,
  type ResolvedPolicyConfig,
} from '../config/policy.js'

/** What `--dir`, `--repo-dir` and `--supervisor-policy` gave, if anything. */
interface PolicyFlags {
  dir?: string | undefined
  repoDir?: string | undefined
  supervisorPolicy: boolean
}

/**
 * The policy directory, checkout and required paths for a CLI command: the flags win, and what they
 * leave out comes from the supervisor config. With no flag and no config the error says so.
 */
export async function resolveCliPolicy(
  env: Record<string, string | undefined>,
  cwd: string,
  repository: string | undefined,
  flags: PolicyFlags,
): Promise<ResolvedPolicyConfig> {
  const overrides: PolicyConfigOverrides = {
    ...(flags.dir !== undefined ? { dir: flags.dir } : {}),
    ...(flags.repoDir !== undefined ? { repoDir: flags.repoDir } : {}),
    supervisorPolicy: flags.supervisorPolicy,
  }
  try {
    return await resolvePolicyFromConfig(env, cwd, repository, overrides)
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code
    if (error instanceof ConfigError && code === 'ENOENT') {
      throw new ConfigError(`${error.message}; or pass --dir`, { cause: error })
    }
    throw error
  }
}
