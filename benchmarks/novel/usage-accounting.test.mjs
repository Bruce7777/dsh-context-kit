import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountSessionUsage, UsageAccountingError } from './usage-accounting.mjs'

const prices = {
  peak: { uncachedInput: '2', cacheRead: '0.1', output: '5' },
  'off-peak': { uncachedInput: '1', cacheRead: '0.02', output: '2' },
}
function usage(inputTokens, cacheReadTokens, outputTokens, reasoningTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens }
}
function fixture() {
  const events = [
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, usage: usage(1_000_000, 0, 100_000, 40_000) } },
    { type: 'compaction/start', data: { turn: 1, compactionId: 'synthetic-summary' } },
    { type: 'compaction/summary', data: { compactionId: 'synthetic-summary', llmStreamCall: true, usage: usage(100_000, 900_000, 20_000, 10_000) } },
    { type: 'compaction/end', data: { turn: 1, compactionId: 'synthetic-summary' } },
    { type: 'assistant/message', data: { turn: 1, usage: usage(300_000, 100_000, 10_000) } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq }))
  return { events, throughSeq: 7, periodsBySeq: { 2: 'peak', 4: 'off-peak', 6: 'peak' }, pricesPerMillionCny: structuredClone(prices) }
}
function rejected(input, code) {
  assert.throws(() => accountSessionUsage(input), error => error instanceof UsageAccountingError && error.code === code)
}
function reindex(input) {
  input.events.forEach((event, seq) => { event.seq = seq })
  input.throughSeq = input.events.length - 1
  input.periodsBySeq = Object.fromEntries(input.events.filter(event => ['assistant/message', 'compaction/summary'].includes(event.type)).map(event => [event.seq, event.type === 'compaction/summary' ? 'off-peak' : 'peak']))
}

test('rejects retry attempts with unavailable usage even when the enclosing turn completed', () => {
  const input = fixture()
  input.events.splice(6, 0, { type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [] } })
  reindex(input)
  rejected(input, 'ATTEMPT_USAGE_UNSUPPORTED')
})

test('includes summary input/output and the later uncached refill in exact complete-task cost', () => {
  const result = accountSessionUsage(fixture())
  assert.deepEqual(result.totals.usage, { inputTokens: 1_400_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 130_000, allInputTokens: 2_400_000, totalTokens: 2_530_000 })
  assert.deepEqual(result.totals.cost, { uncachedInputCny: '2.7', cacheReadCny: '0.028', cacheWriteCny: '0', outputCny: '0.59', totalCny: '3.318' })
  assert.equal(result.byPurpose.main.cost.totalCny, '3.16')
  assert.deepEqual(result.byPurpose.summary.cost, { uncachedInputCny: '0.1', cacheReadCny: '0.018', cacheWriteCny: '0', outputCny: '0.04', totalCny: '0.158' })
  assert.deepEqual(result.calls.map(call => call.cost.totalCny), ['2.5', '0.158', '0.66'])
  assert.deepEqual(result.compactions, [{ compactionId: 'synthetic-summary', startSeq: 3, summarySeq: 4, endSeq: 5, status: 'completed' }])
})

test('negative controls: main-only and omitted-summary-output claims fail the independently stated invoice', () => {
  const result = accountSessionUsage(fixture())
  const checkClaim = claimed => assert.equal(claimed, '3.318')
  assert.throws(() => checkClaim(result.byPurpose.main.cost.totalCny), assert.AssertionError)
  assert.throws(() => checkClaim('3.278'), assert.AssertionError) // Correct invoice minus the 0.04 summary output fee.
  checkClaim(result.totals.cost.totalCny)
  const missingOutput = fixture(); delete missingOutput.events[4].data.usage.outputTokens
  rejected(missingOutput, 'MISSING_USAGE_FIELD')
  const zeroedOutput = fixture(); zeroedOutput.events[4].data.usage.outputTokens = 0
  rejected(zeroedOutput, 'INCONSISTENT_TOTAL_TOKENS')
})

test('uses each call’s explicit peak/off-peak price without choosing a time band', () => {
  const input = fixture(), result = accountSessionUsage(input)
  assert.equal(result.byPeriod.peak.cost.totalCny, '3.16')
  assert.equal(result.byPeriod['off-peak'].cost.totalCny, '0.158')
  input.periodsBySeq[4] = 'peak'
  assert.equal(accountSessionUsage(input).byPurpose.summary.cost.totalCny, '0.39')
  delete input.periodsBySeq[4]
  rejected(input, 'MISSING_OR_INVALID_PERIOD')
})

test('reasoning is a subset of billed output, never an additional output fee', () => {
  const input = fixture()
  const withReasoning = accountSessionUsage(input)
  for (const event of input.events) if (event.data.usage) delete event.data.usage.reasoningTokens
  assert.deepEqual(accountSessionUsage(input).totals, withReasoning.totals)
  assert.equal(withReasoning.byPurpose.summary.usage.outputTokens, 20_000)
  assert.equal(withReasoning.byPurpose.summary.cost.outputCny, '0.04')
  input.events[4].data.usage.reasoningTokens = 20_001
  rejected(input, 'REASONING_EXCEEDS_OUTPUT')
})

test('refuses absent main usage, summary usage, and unknown cache counters', () => {
  for (const seq of [2, 4, 6]) {
    const input = fixture(); delete input.events[seq].data.usage
    rejected(input, 'MISSING_USAGE')
  }
  const input = fixture(); delete input.events[4].data.usage.cacheReadTokens
  rejected(input, 'MISSING_USAGE_FIELD')
})

test('rejects unsafe/negative counts and inconsistent provider totals', () => {
  for (const value of [-1, .5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.events[4].data.usage.inputTokens = value
    rejected(input, 'INVALID_TOKEN_COUNT')
  }
  const input = fixture(); input.events[4].data.usage.totalTokens += 10_000
  rejected(input, 'INCONSISTENT_TOTAL_TOKENS')
})

test('filtered, reordered or truncated raw prefixes cannot masquerade as complete accounting', () => {
  const filtered = fixture(); filtered.events = filtered.events.filter(event => event.type !== 'compaction/summary'); filtered.throughSeq = 6
  rejected(filtered, 'NONCONTIGUOUS_OR_INVALID_EVENT')
  const reordered = fixture(); [reordered.events[2], reordered.events[3]] = [reordered.events[3], reordered.events[2]]
  rejected(reordered, 'NONCONTIGUOUS_OR_INVALID_EVENT')
  const unclosed = fixture(); unclosed.throughSeq = 4
  rejected(unclosed, 'UNCLOSED_COMPACTION')
})

test('unmatched summary/end and missing summary are rejected even with consecutive synthetic seqs', () => {
  const orphan = fixture(); orphan.events.splice(3, 1); reindex(orphan)
  rejected(orphan, 'UNMATCHED_SUMMARY')
  const wrongId = fixture(); wrongId.events[5].data.compactionId = 'different-synthetic-summary'
  rejected(wrongId, 'UNMATCHED_COMPACTION_END')
  const missing = fixture(); missing.events.splice(4, 1); reindex(missing)
  rejected(missing, 'MISSING_SUMMARY')
})

test('duplicate summary/start cannot double-charge a call', () => {
  const duplicate = fixture(); duplicate.events.splice(5, 0, structuredClone(duplicate.events[4])); reindex(duplicate)
  rejected(duplicate, 'DUPLICATE_SUMMARY')
  const start = fixture(); start.events.splice(4, 0, structuredClone(start.events[3])); reindex(start)
  rejected(start, 'DUPLICATE_OR_OVERLAPPING_COMPACTION')
})

test('failed summarization without recorded usage is unknown cost, not zero', () => {
  const input = fixture(); input.events.splice(4, 1); reindex(input)
  input.events.find(event => event.type === 'compaction/end').data.error = 'synthetic failure'
  rejected(input, 'FAILED_SUMMARY_USAGE_UNKNOWN')
})

test('a failed compaction after recorded generation still bills that summary', () => {
  const input = fixture(); input.events[5].data.error = 'synthetic failure after usage was recorded'
  const result = accountSessionUsage(input)
  assert.equal(result.byPurpose.summary.cost.totalCny, '0.158')
  assert.equal(result.totals.cost.totalCny, '3.318')
  assert.equal(result.compactions[0].status, 'failed-with-recorded-usage')
})

test('nonzero cache writes need a price and are disjoint billed input', () => {
  const input = fixture(); input.events[4].data.usage = usage(100_000, 900_000, 20_000, 0, 50_000)
  rejected(input, 'CACHE_WRITE_UNPRICED')
  input.pricesPerMillionCny['off-peak'].cacheWrite = '0.4'
  const result = accountSessionUsage(input)
  assert.equal(result.byPurpose.summary.cost.cacheWriteCny, '0.02')
  assert.equal(result.byPurpose.summary.usage.allInputTokens, 1_050_000)
  assert.equal(result.totals.cost.totalCny, '3.338')
})

test('decimal-string arithmetic retains sub-cent precision without per-call rounding', () => {
  const input = fixture()
  input.pricesPerMillionCny = { peak: { uncachedInput: '0.000001', cacheRead: '0', output: '0' }, 'off-peak': { uncachedInput: '0.000001', cacheRead: '0', output: '0' } }
  for (const event of input.events) if (event.data.usage) event.data.usage = usage(1, 0, 0)
  assert.equal(accountSessionUsage(input).totals.cost.totalCny, '0.000000000003')
  input.pricesPerMillionCny.peak.uncachedInput = 0.000001
  rejected(input, 'INVALID_DECIMAL_PRICE')
})

test('explicit cutoff excludes later in-flight work without mutating or resequencing input', () => {
  const input = fixture(); input.events.push({ seq: 8, type: 'turn/start', data: { turn: 2 } })
  const before = structuredClone(input)
  assert.equal(accountSessionUsage(input).totals.cost.totalCny, '3.318')
  assert.deepEqual(input, before)
  input.throughSeq = 8
  rejected(input, 'INCOMPLETE_PREFIX')
})

test('turn ownership and completed outcome are required for the claimed prefix', () => {
  const owner = fixture(); owner.events[5].data.turn = 2
  rejected(owner, 'COMPACTION_OWNER_MISMATCH')
  const incomplete = fixture(); incomplete.events[7].data.reason.kind = 'cancelled'
  rejected(incomplete, 'INCOMPLETE_OR_FAILED_TURN')
})

test('counts multiple native summaries across turns without any context-kit-specific event', () => {
  const input = fixture()
  const second = structuredClone(input.events.slice(1))
  for (const event of second) {
    if (event.data.turn !== undefined) event.data.turn = 2
    if (event.data.compactionId !== undefined) event.data.compactionId = 'another-native-summary'
  }
  input.events.push(...second); reindex(input)
  const result = accountSessionUsage(input)
  assert.equal(result.completedTurns, 2)
  assert.equal(result.byPurpose.summary.calls, 2)
  assert.equal(result.byPurpose.summary.cost.outputCny, '0.08')
  assert.equal(result.totals.cost.totalCny, '6.636')
})

test('a baseline has zero summary cost only when no summary lifecycle is present', () => {
  const input = fixture()
  input.events = input.events.filter(event => !event.type.startsWith('compaction/'))
  reindex(input)
  const result = accountSessionUsage(input)
  assert.equal(result.byPurpose.summary.calls, 0)
  assert.equal(result.byPurpose.summary.cost.totalCny, '0')
  assert.equal(result.totals.cost.totalCny, '3.16')
})
