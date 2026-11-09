/** Export a content-free accounting field projection; never export replayable Session contents. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { OFFICIAL_PRICES, PRICE_DATE, PRICE_SOURCE, PROJECTION_NOTICE, verifyReportData } from './verify-report.mjs'

function fail(code, seq) {
  const error = new Error('Accounting export rejected')
  error.code = code
  error.seq = seq
  throw error
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function count(value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_COUNTER'); return value }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
const usageFields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']
const billedFields = usageFields.slice(0, 4)

/** Copy only numeric provider counters; absence remains visible to the verifier. */
function projectUsage(value) {
  if (!object(value)) fail('INVALID_USAGE')
  return Object.fromEntries(usageFields.filter(field => Object.hasOwn(value, field)).map(field => [field, count(value[field])]))
}

/** Rebuild payloads from the whitelist; no generic object spreading of private data. */
function projectEvents(events) {
  const ids = new Map()
  const anonymous = value => {
    if (typeof value !== 'string' || !value) fail('INVALID_COMPACTION_ID')
    if (!ids.has(value)) ids.set(value, `compact${String(ids.size + 1).padStart(3, '0')}`)
    return ids.get(value)
  }
  return events.map((event, seq) => {
    if (!object(event) || event.seq !== seq || !object(event.data) || typeof event.type !== 'string') fail('NONCONTIGUOUS_SOURCE', seq)
    count(event.time)
    const data = {}
    if (Object.hasOwn(event.data, 'turn')) data.turn = event.data.turn === null ? null : count(event.data.turn)
    if (Object.hasOwn(event.data, 'step')) data.step = count(event.data.step)
    if (Object.hasOwn(event.data, 'error') || object(event.data.reason) && Object.hasOwn(event.data.reason, 'error')) data.error = true
    if (event.type === 'user/message' && object(event.data.source)) data.source = { kind: event.data.source.kind }
    if (event.type === 'assistant/message' || event.type === 'compaction/summary') {
      if (event.data.usage !== undefined) data.usage = projectUsage(event.data.usage)
    }
    if (['compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type)) data.compactionId = anonymous(event.data.compactionId)
    if (event.type === 'turn/end' && object(event.data.reason)) data.reason = { kind: event.data.reason.kind }
    if (event.type === 'request/header') {
      const original = event.data.header?.config
      if (!object(original)) fail('INVALID_REQUEST_CONFIG', seq)
      const config = {}
      for (const field of ['provider', 'model', 'reasoningEffort', 'maxTokens']) if (Object.hasOwn(original, field)) config[field] = original[field]
      data.header = { config }
    }
    return { seq: event.seq, type: event.type, time: event.time, data }
  })
}

/** Official rates yield exact multiples of 1e-8 CNY; remove only source floating-point noise. */
function moneyUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_EXPECTED_MONEY')
  const fixed = value.toFixed(8)
  if (Math.abs(value - Number(fixed)) > 1e-9) fail('EXPECTED_MONEY_OUTSIDE_PRICE_QUANTUM')
  return BigInt(fixed.replace('.', ''))
}
function money(value) {
  if (value === 0n) return '0'
  const digits = value.toString().padStart(9, '0')
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`.replace(/0+$/u, '').replace(/\.$/u, '')
}
function callCosts(call) {
  if (!object(call.components)) fail('INVALID_EXPECTED_COMPONENTS')
  const values = { uncachedInputCny: moneyUnits(call.components.uncachedInput), cacheReadCny: moneyUnits(call.components.cacheRead),
    cacheWriteCny: 0n, outputCny: moneyUnits(call.components.output) }
  const total = Object.values(values).reduce((sum, value) => sum + value, 0n)
  if (total !== moneyUnits(call.estimatedCny)) fail('EXPECTED_CALL_COMPONENT_MISMATCH')
  return Object.fromEntries([...Object.entries(values).map(([key, value]) => [key, money(value)]), ['totalCny', money(total)]])
}
function expectedGroup(calls) {
  const usage = Object.fromEntries(billedFields.map(field => [field, 0]))
  const costs = { uncachedInputCny: 0n, cacheReadCny: 0n, cacheWriteCny: 0n, outputCny: 0n }
  for (const call of calls) {
    if (!object(call.usage)) fail('MISSING_EXPECTED_USAGE')
    for (const field of billedFields) usage[field] = count(usage[field] + count(call.usage[field]))
    costs.uncachedInputCny += moneyUnits(call.components.uncachedInput)
    costs.cacheReadCny += moneyUnits(call.components.cacheRead)
    costs.outputCny += moneyUnits(call.components.output)
  }
  usage.allInputTokens = count(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
  usage.totalTokens = count(usage.allInputTokens + usage.outputTokens)
  return { calls: calls.length, usage, cost: Object.fromEntries([
    ...Object.entries(costs).map(([key, value]) => [key, money(value)]),
    ['totalCny', money(Object.values(costs).reduce((sum, value) => sum + value, 0n))],
  ]) }
}

function exportReport(runDirectory, through, outputDirectory) {
  const progress = JSON.parse(readFileSync(join(runDirectory, 'progress.json'), 'utf8'))
  const sourceCost = JSON.parse(readFileSync(join(runDirectory, `cost-through-${String(through).padStart(3, '0')}.json`), 'utf8'))
  if (sourceCost.throughRound !== through || sourceCost.model !== 'deepseek-flash' || sourceCost.currency !== 'CNY'
    || sourceCost.source !== PRICE_SOURCE) fail('WRONG_SOURCE_COST_REPORT')
  const report = {
    format: 'dsh-novel-accounting-projection', version: 1, notice: PROJECTION_NOTICE,
    disclosure: 'Every sequence position in the declared cut is retained, with selected payload fields omitted. Complete Session contents are not published.',
    throughRound: through,
    priceRecord: { date: PRICE_DATE, source: PRICE_SOURCE, currency: 'CNY', priceUnit: 'per-million-tokens', model: 'deepseek-flash', pricesPerMillionCny: OFFICIAL_PRICES },
    periodAssignment: {
      basis: 'Recorded cost.calls tier; no period inference during verification.', timezone: 'Asia/Shanghai',
      assumption: 'November 9, 2026 is treated as an ordinary Monday. Each call keeps the recorded start-tier assignment. For calls crossing a tariff boundary including 18:00, start/finish-tier bounds are retained because the official page does not specify settlement. This is an estimate, not a provider invoice.',
    },
    lanes: {},
  }
  const projections = {}
  const serialized = {}
  for (const [laneName, port] of [['candidate', 3080], ['baseline', 3082]]) {
    const turns = progress.turns.filter(turn => turn.port === port && turn.round <= through).sort((a, b) => a.round - b.round)
    if (turns.length !== through || turns.some((turn, index) => turn.round !== index + 1)) fail('INCOMPLETE_COMMON_ROUNDS')
    const throughSeq = count(turns.at(-1).throughSeq)
    const sourceBytes = readFileSync(join(runDirectory, `events-${port}.jsonl`))
    const sourceLines = sourceBytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim() !== '')
    if (sourceLines.length <= throughSeq) fail('INCOMPLETE_SOURCE_PREFIX')
    const events = sourceLines.slice(0, throughSeq + 1).map(line => JSON.parse(line))
    if (events.some(event => event.type === 'compaction/summary'
      && (event.data?.provider !== 'deepseek-official' || event.data?.model !== 'deepseek-flash'))) fail('UNPRICED_SUMMARY_ROUTE')
    const projected = projectEvents(events)
    const calls = sourceCost.lanes?.[port]?.calls
    const expectedTotals = sourceCost.lanes?.[port]?.total
    if (!Array.isArray(calls) || !object(expectedTotals)) fail('MISSING_COST_LANE')
    const costTotals = expectedGroup(calls)
    const sourceTotals = { uncachedInputCny: money(moneyUnits(expectedTotals.uncachedInputCny)), cacheReadCny: money(moneyUnits(expectedTotals.cachedInputCny)),
      cacheWriteCny: '0', outputCny: money(moneyUnits(expectedTotals.outputCny)), totalCny: money(moneyUnits(expectedTotals.estimatedCny)) }
    if (JSON.stringify(sourceTotals) !== JSON.stringify(costTotals.cost)) fail('SOURCE_COST_TOTAL_MISMATCH')
    projections[laneName] = projected
    serialized[laneName] = projected.map(event => JSON.stringify(event)).join('\n') + '\n'
    report.lanes[laneName] = {
      throughSeq, projectedEventCount: projected.length, projectionFile: `${laneName}.events.projected.jsonl`,
      projectionSha256: sha256(serialized[laneName]), sourceFileSha256: sha256(sourceBytes),
      calls: calls.map(call => ({ seq: call.seq, type: call.type, round: call.round, period: call.tier,
        startAt: call.startAt, endAt: call.endAt, timingBasis: call.timingBasis, crossTier: call.crossTier,
        expectedCost: callCosts(call) })),
      expected: {
        totals: costTotals,
        byPurpose: { main: expectedGroup(calls.filter(call => call.type === 'assistant/message')), summary: expectedGroup(calls.filter(call => call.type === 'compaction/summary')) },
        byPeriod: { peak: expectedGroup(calls.filter(call => call.tier === 'peak')), 'off-peak': expectedGroup(calls.filter(call => call.tier === 'off-peak')) },
        counters: { completedTurns: through, mainCalls: calls.filter(call => call.type === 'assistant/message').length,
          summaryCalls: calls.filter(call => call.type === 'compaction/summary').length, peakCalls: expectedTotals.peakCalls,
          offPeakCalls: expectedTotals.offPeakCalls, crossTierCalls: expectedTotals.crossTierCalls },
        pricingBounds: Object.fromEntries(['lowerCny', 'upperCny', 'allOffPeakCny', 'allPeakCny'].map(field => [field, money(moneyUnits(expectedTotals[field]))])),
      },
    }
  }
  const verified = verifyReportData(report, projections)
  mkdirSync(outputDirectory, { recursive: true })
  for (const laneName of ['candidate', 'baseline']) {
    const file = join(outputDirectory, report.lanes[laneName].projectionFile)
    writeFileSync(`${file}.tmp`, serialized[laneName])
    renameSync(`${file}.tmp`, file)
  }
  const reportFile = join(outputDirectory, 'accounting-report.json')
  writeFileSync(`${reportFile}.tmp`, JSON.stringify(report, null, 2) + '\n')
  renameSync(`${reportFile}.tmp`, reportFile)
  console.log(JSON.stringify({ exported: true, throughRound: through, notice: PROJECTION_NOTICE,
    lanes: Object.fromEntries(Object.entries(verified).map(([lane, value]) => [lane, { events: report.lanes[lane].projectedEventCount,
      calls: value.calls.length, summaryOutputTokens: value.byPurpose.summary.usage.outputTokens,
      summaryOutputCny: value.byPurpose.summary.cost.outputCny, totalCny: value.totals.cost.totalCny }])) }, null, 2))
}

try {
  const { values } = parseArgs({ options: { 'run-dir': { type: 'string' }, through: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } }, strict: true })
  if (values.help) console.log('Usage: node export-accounting.mjs --run-dir PRIVATE_RUN_DIRECTORY --through N --out OUTPUT_DIRECTORY')
  else {
    if (!values['run-dir'] || !values.out || !values.through) fail('MISSING_EXPORT_ARGUMENT')
    const through = Number(values.through)
    if (!Number.isSafeInteger(through) || through < 1) fail('INVALID_THROUGH_ROUND')
    exportReport(values['run-dir'], through, values.out)
  }
} catch (error) {
  console.error(`Export failed: ${typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : 'INVALID_INPUT_OR_IO'}`)
  process.exitCode = 1
}
