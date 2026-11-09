/** Load-time validation of absolute context and historical-result budgets. @module */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { BudgetedCompactionConfig, ResolvedBudgetedConfig } from './types.js'

const BUDGET_KEYS = new Set([
  'pruneToolResults', 'maxContextTokens', 'toolHistoryTokens', 'toolHistoryTargetRatio', 'protectedSteps',
  'minSavingsTokens', 'toolHeadChars', 'toolTailChars', 'toolMetaMaxChars', 'summaryTargetTokens',
])

/**
 * Validate deployment budgets and separate the inherited compaction settings.
 * @param config - untrusted plugin configuration.
 * @returns detached immutable budgets; automatic handlers await projection readiness.
 */
export function resolveBudgetConfig(config: BudgetedCompactionConfig = {}): ResolvedBudgetedConfig {
  const inheritedKeys = new Set(Object.keys(BasicCompactionEngine.Config.dict ?? {}))
  const basic: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (inheritedKeys.has(key)) basic[key] = value
    else if (!BUDGET_KEYS.has(key)) throw new Error(`BudgetedCompactionConfig: unknown key "${key}"`)
  }
  if (config.pruneToolResults !== undefined && typeof config.pruneToolResults !== 'boolean') {
    throw new Error('BudgetedCompactionConfig: pruneToolResults must be a boolean')
  }
  const pruneToolResults = config.pruneToolResults ?? false
  const maxContextTokens = positive('maxContextTokens', config.maxContextTokens ?? 131_072)
  const toolHistoryTokens = positive('toolHistoryTokens', config.toolHistoryTokens ?? 32_768)
  const minSavingsTokens = positive('minSavingsTokens', config.minSavingsTokens ?? 1_024)
  const summaryTargetTokens = positive('summaryTargetTokens', config.summaryTargetTokens ?? 4_096)
  const protectedSteps = nonnegative('protectedSteps', config.protectedSteps ?? 2)
  const toolHeadChars = nonnegative('toolHeadChars', config.toolHeadChars ?? 1_024)
  const toolMetaMaxChars = nonnegative('toolMetaMaxChars', config.toolMetaMaxChars ?? 4096)
  const toolTailChars = nonnegative('toolTailChars', config.toolTailChars ?? 512)
  const toolHistoryTargetRatio = config.toolHistoryTargetRatio ?? 0.75
  if (!Number.isFinite(toolHistoryTargetRatio) || toolHistoryTargetRatio <= 0 || toolHistoryTargetRatio >= 1) {
    throw new Error('BudgetedCompactionConfig: toolHistoryTargetRatio must be in (0, 1)')
  }
  if (toolHistoryTokens > maxContextTokens) {
    throw new Error('BudgetedCompactionConfig: toolHistoryTokens must not exceed maxContextTokens')
  }
  if (summaryTargetTokens + minSavingsTokens >= maxContextTokens) {
    throw new Error('BudgetedCompactionConfig: summaryTargetTokens + minSavingsTokens must be below maxContextTokens')
  }
  if (config.retainRatio === undefined && config.retainTokens === undefined) basic.retainTokens = 24_576
  if (config.maxTokens === undefined) basic.maxTokens = 16_384
  const automatic = config.auto ?? true
  return deepFreeze({
    pruneToolResults, maxContextTokens, toolHistoryTokens, toolHistoryTargetRatio, protectedSteps,
    minSavingsTokens, toolHeadChars, toolTailChars, toolMetaMaxChars, summaryTargetTokens, automatic,
    basic: { ...basic, auto: automatic },
  })
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`BudgetedCompactionConfig: ${name} must be a positive safe integer`)
  return value
}

function nonnegative(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`BudgetedCompactionConfig: ${name} must be a non-negative safe integer`)
  return value
}
