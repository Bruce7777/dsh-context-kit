/** Configuration of the optional budget-driven compaction backend. @module */
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Absolute context and historical-tool budgets applied alongside routed window limits. */
export interface BudgetedCompactionConfig extends BasicCompactionConfig {
  /** Opt in to batched old-tool-result pruning; false preserves warm history prefixes. Defaults to false. */
  pruneToolResults?: boolean
  /** Maximum estimated request pressure before summary compaction. Defaults to 131072. */
  maxContextTokens?: number
  /** Total current tool-result tokens that trigger historical pruning. Defaults to 32768. */
  toolHistoryTokens?: number
  /** Fraction of the tool budget targeted by one pruning batch. Defaults to 0.75. */
  toolHistoryTargetRatio?: number
  /** Most recent completed tool steps whose results remain verbatim. Defaults to 2. */
  protectedSteps?: number
  /** Minimum estimated saving required before pruning or selecting a summary region. Defaults to 1024. */
  minSavingsTokens?: number
  /** Leading Unicode code points retained in an older tool result. Defaults to 1024. */
  toolHeadChars?: number
  /** Trailing Unicode code points retained in an older tool result. Defaults to 512. */
  toolTailChars?: number
  /** Largest complete result metadata retained beside a preview, in JSON characters. Defaults to 4096. */
  toolMetaMaxChars?: number
  /** Text-summary target supplied to the model, separate from the generation cap. Defaults to 4096. */
  summaryTargetTokens?: number
}

/** Validated budget policy and separately resolved Basic settings. */
export interface ResolvedBudgetedConfig {
  readonly pruneToolResults: boolean
  readonly maxContextTokens: number
  readonly toolHistoryTokens: number
  readonly toolHistoryTargetRatio: number
  readonly protectedSteps: number
  readonly minSavingsTokens: number
  readonly toolHeadChars: number
  readonly toolTailChars: number
  readonly toolMetaMaxChars: number
  readonly summaryTargetTokens: number
  readonly automatic: boolean
  readonly basic: BasicCompactionConfig
}
