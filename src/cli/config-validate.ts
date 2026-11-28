import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { scheduledPromptsHistoryError } from '../config/defaults.js'
import type { SupervisorConfig } from '../config/types.js'

export interface ConfigValidationError {
  path: string
  message: string
}

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; errors: ConfigValidationError[] }

const schemaUrl = new URL('../../schemas/config.json', import.meta.url)

let cachedValidate: ValidateFunction | undefined

function getValidator(): ValidateFunction {
  if (!cachedValidate) {
    const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as object
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    cachedValidate = ajv.compile(schema)
  }
  return cachedValidate
}

function formatError(error: ErrorObject): ConfigValidationError {
  const path = error.instancePath || '/'
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty: string }).additionalProperty
    return { path, message: `${error.message!} (${extra})` }
  }
  return { path, message: error.message! }
}

export function validateConfigData(data: unknown): ConfigValidationResult {
  const validate = getValidator()
  if (!validate(data)) {
    return {
      valid: false,
      errors: validate.errors!.map(formatError),
    }
  }
  const historyError = scheduledPromptsHistoryError((data as SupervisorConfig).scheduledPrompts)
  if (historyError !== undefined) {
    return {
      valid: false,
      errors: [{ path: '/scheduledPrompts/history', message: historyError }],
    }
  }
  return { valid: true }
}

export async function validateConfigFile(filePath: string): Promise<ConfigValidationResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: '/', message: `Cannot read file: ${(error as Error).message}` }],
    }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: '/', message: `Invalid JSON: ${(error as Error).message}` }],
    }
  }

  return validateConfigData(data)
}
