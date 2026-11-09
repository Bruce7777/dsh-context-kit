import { describe, expect, it } from 'vitest'
import { resolveBudgetConfig } from '../../src/budgeted/config.js'

describe('budgeted compaction settings', () => {
  it('separates absolute budgets from inherited defaults', () => {
    expect(resolveBudgetConfig()).toMatchObject({
      pruneToolResults: false,
      maxContextTokens: 131072,
      toolHistoryTokens: 32768,
      toolHistoryTargetRatio: 0.75,
      protectedSteps: 2,
      minSavingsTokens: 1024,
      summaryTargetTokens: 4096,
      automatic: true,
      basic: { auto: true, retainTokens: 24576, maxTokens: 16384 },
    })
  })

  it('keeps explicit route, retention, generation and automatic choices', () => {
    const value = resolveBudgetConfig({
      auto: false, maxTokens: 8192, retainRatio: 0.1,
      summarizationProvider: 'route', summarizationModel: 'small',
    })
    expect(value.automatic).toBe(false)
    expect(value.basic).toEqual({
      auto: false, maxTokens: 8192, retainRatio: 0.1,
      summarizationProvider: 'route', summarizationModel: 'small',
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.basic)).toBe(true)
  })

  it.each([
    { maxContextTokens: 0 }, { toolHistoryTokens: -1 }, { minSavingsTokens: 0 },
    { protectedSteps: -1 }, { toolHeadChars: 0.5 }, { toolTailChars: Number.NaN },
    { summaryTargetTokens: Number.POSITIVE_INFINITY }, { toolHistoryTargetRatio: 0 },
    { toolHistoryTargetRatio: 1 }, { toolHistoryTargetRatio: Number.NaN },
    { maxContextTokens: 10000, toolHistoryTokens: 10001 },
    { maxContextTokens: 10000, toolHistoryTokens: 1000, summaryTargetTokens: 9000, minSavingsTokens: 1000 },
  ])('rejects invalid budgets before activation: %j', (config) => {
    expect(() => resolveBudgetConfig(config)).toThrow('BudgetedCompactionConfig:')
  })

  it('rejects unknown settings rather than silently choosing defaults', () => {
    expect(() => resolveBudgetConfig({ obsolete: true } as never)).toThrow('unknown key "obsolete"')
  })
})
