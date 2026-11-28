import { extractClassifierCalls } from './condition-validate.js'
import type { ClassifierResult, ConditionExpr } from './types.js'

/** The classifiers a condition names that have no result, each once, as the condition spells them. */
export function missingClassifiers(
  expr: ConditionExpr,
  classifiers: Record<string, ClassifierResult>,
): string[] {
  const missing = new Set<string>()
  for (const call of extractClassifierCalls(expr)) {
    const key = call.version !== undefined ? `${call.name}@${call.version}` : call.name
    if (!classifiers[key] && !classifiers[call.name]) missing.add(key)
  }
  return [...missing]
}
