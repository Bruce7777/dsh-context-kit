/** Offline verification of a deliberately non-replayable, content-free accounting projection. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { accountSessionUsage } from './usage-accounting.mjs'

export const PROJECTION_NOTICE = '仅用于费用审计的字段投影，不是可重放的Session日志'
export const PRICE_DATE = '2026-11-09'
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
export const OFFICIAL_PRICES = Object.freeze({
  peak: Object.freeze({ uncachedInput: '2', cacheRead: '0.04', output: '8' }),
  'off-peak': Object.freeze({ uncachedInput: '1', cacheRead: '0.02', output: '4' }),
})

function fail(code, seq) {
  const error = new Error(`Accounting projection: ${code}${seq === undefined ? '' : ` at seq ${seq}`}`)
  error.code = code
  throw error
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value, allowed, seq) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('FORBIDDEN_FIELD', seq)
}
function count(value, seq) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_COUNTER', seq) }
function equal(actual, expected, code) { if (!isDeepStrictEqual(actual, expected)) fail(code) }
function token(value, seq) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]*$/iu.test(value)
    || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(value)) fail('UNSAFE_LABEL', seq)
}
function decimal(value) { if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/u.test(value)) fail('INVALID_DECIMAL') }
function usage(value, seq) {
  keys(value, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'], seq)
  for (const number of Object.values(value)) count(number, seq)
}

/** Validate the payload whitelist independently of the exporter. */
function projectedEvent(event, index) {
  keys(event, ['seq', 'type', 'time', 'data'], index)
  if (event.seq !== index || typeof event.type !== 'string' || !/^[a-z][a-z0-9._:/-]*$/iu.test(event.type)) fail('INVALID_EVENT', index)
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(event.type)) fail('UNSAFE_EVENT_TYPE', index)
  count(event.time, index)
  const allowed = ['turn', 'step', 'error']
  if (event.type === 'user/message') allowed.push('source')
  if (event.type === 'assistant/message') allowed.push('usage')
  if (['compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type)) allowed.push('compactionId')
  if (event.type === 'compaction/summary') allowed.push('usage')
  if (event.type === 'request/header') allowed.push('header')
  if (event.type === 'turn/end') allowed.push('reason')
  keys(event.data, allowed, index)
  if (event.data.turn !== undefined && event.data.turn !== null) count(event.data.turn, index)
  if (event.data.step !== undefined) count(event.data.step, index)
  if (event.data.error !== undefined && event.data.error !== true) fail('ERROR_TEXT_FORBIDDEN', index)
  if (event.data.source !== undefined) {
    keys(event.data.source, ['kind'], index)
    token(event.data.source.kind, index)
  }
  if (event.data.reason !== undefined) {
    keys(event.data.reason, ['kind'], index)
    token(event.data.reason.kind, index)
  }
  if (event.data.compactionId !== undefined && !/^compact\d{3,}$/u.test(event.data.compactionId)) fail('NONANONYMOUS_COMPACTION_ID', index)
  if (event.data.usage !== undefined) usage(event.data.usage, index)
  if (event.data.header !== undefined) {
    keys(event.data.header, ['config'], index)
    const config = event.data.header.config
    keys(config, ['provider', 'model', 'reasoningEffort', 'maxTokens'], index)
    token(config.provider, index)
    token(config.model, index)
    if (config.reasoningEffort !== undefined) token(config.reasoningEffort, index)
    if (config.maxTokens !== undefined) count(config.maxTokens, index)
  }
  if (event.type === 'assistant/attempt') fail('UNSUPPORTED_ATTEMPT_ACCOUNTING', index)
}

/**
 * Verify content-free events and all expected exact-decimal call and aggregate charges.
 * @param report - exported report metadata, fixed prices, recorded periods and expected charges.
 * @param projections - original-order field projections keyed by candidate and baseline.
 * @returns validated exact accounting reports for each lane.
 */
export function verifyReportData(report, projections) {
  keys(report, ['format', 'version', 'notice', 'disclosure', 'throughRound', 'priceRecord', 'periodAssignment', 'lanes'])
  if (report.format !== 'dsh-novel-accounting-projection' || report.version !== 1 || report.notice !== PROJECTION_NOTICE) fail('WRONG_REPORT_FORMAT')
  if (report.disclosure !== 'Every sequence position in the declared cut is retained, with selected payload fields omitted. Complete Session contents are not published.') fail('WRONG_DISCLOSURE')
  count(report.throughRound)
  if (report.throughRound < 1) fail('INVALID_ROUND')
  equal(report.priceRecord, { date: PRICE_DATE, source: PRICE_SOURCE, currency: 'CNY', priceUnit: 'per-million-tokens',
    model: 'deepseek-flash', pricesPerMillionCny: OFFICIAL_PRICES }, 'PRICE_RECORD_MISMATCH')
  equal(report.periodAssignment, {
    basis: 'Recorded cost.calls tier; no period inference during verification.', timezone: 'Asia/Shanghai',
    assumption: 'November 9, 2026 is treated as an ordinary Monday. Each call keeps the recorded start-tier assignment. For calls crossing a tariff boundary including 18:00, start/finish-tier bounds are retained because the official page does not specify settlement. This is an estimate, not a provider invoice.',
  }, 'PERIOD_ASSUMPTION_MISMATCH')
  keys(report.lanes, ['candidate', 'baseline'])
  keys(projections, ['candidate', 'baseline'])
  const verified = {}
  for (const laneName of ['candidate', 'baseline']) {
    const lane = report.lanes[laneName]
    keys(lane, ['throughSeq', 'projectedEventCount', 'projectionFile', 'projectionSha256', 'sourceFileSha256', 'calls', 'expected'])
    if (lane.projectionFile !== `${laneName}.events.projected.jsonl`) fail('UNSAFE_PROJECTION_FILE')
    for (const hash of [lane.projectionSha256, lane.sourceFileSha256]) if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) fail('INVALID_SHA256')
    count(lane.throughSeq)
    const events = projections[laneName]
    if (!Array.isArray(events) || events.length !== lane.throughSeq + 1 || lane.projectedEventCount !== events.length) fail('WRONG_PROJECTION_CUT')
    events.forEach(projectedEvent)
    const roundBySeq = new Map()
    let round = 0
    let config
    for (const event of events) {
      if (event.type === 'turn/start') round += 1
      if (event.type === 'request/header') config = event.data.header.config
      if (event.type === 'assistant/message') {
        if (config?.provider !== 'deepseek-official' || config.model !== 'deepseek-flash') fail('UNPRICED_MAIN_ROUTE', event.seq)
        roundBySeq.set(event.seq, round)
      }
      if (event.type === 'compaction/summary') roundBySeq.set(event.seq, round)
    }
    if (!Array.isArray(lane.calls)) fail('INVALID_CALLS')
    const periodsBySeq = {}
    for (const call of lane.calls) {
      keys(call, ['seq', 'type', 'round', 'period', 'startAt', 'endAt', 'timingBasis', 'crossTier', 'expectedCost'])
      count(call.seq)
      count(call.round)
      if (call.round < 1 || call.round > report.throughRound || !['assistant/message', 'compaction/summary'].includes(call.type)
        || !['peak', 'off-peak'].includes(call.period) || Object.hasOwn(periodsBySeq, call.seq)) fail('INVALID_CALL_PERIOD', call.seq)
      if (call.round !== roundBySeq.get(call.seq)) fail('CALL_ROUND_MISMATCH', call.seq)
      if (!['delivery-accepted', 'start-marker'].includes(call.timingBasis) || typeof call.crossTier !== 'boolean') fail('INVALID_CALL_TIMING', call.seq)
      for (const time of [call.startAt, call.endAt]) if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(time) || !Number.isFinite(Date.parse(time))) fail('INVALID_CALL_TIME', call.seq)
      if (Date.parse(call.startAt) > Date.parse(call.endAt) || events[call.seq]?.time !== Date.parse(call.endAt)) fail('CALL_TIME_MISMATCH', call.seq)
      keys(call.expectedCost, ['uncachedInputCny', 'cacheReadCny', 'cacheWriteCny', 'outputCny', 'totalCny'])
      Object.values(call.expectedCost).forEach(decimal)
      periodsBySeq[call.seq] = call.period
    }
    const actual = accountSessionUsage({ events, throughSeq: lane.throughSeq, periodsBySeq, pricesPerMillionCny: OFFICIAL_PRICES })
    if (actual.completedTurns !== report.throughRound || actual.calls.length !== lane.calls.length) fail('CALL_OR_ROUND_COUNT_MISMATCH')
    for (const [index, call] of actual.calls.entries()) {
      const expected = lane.calls[index]
      if (call.seq !== expected.seq || call.type !== expected.type || call.period !== expected.period) fail('CALL_COVERAGE_MISMATCH', call.seq)
      equal(call.cost, expected.expectedCost, 'EXPECTED_CALL_COST_MISMATCH')
    }
    const counters = { completedTurns: actual.completedTurns, mainCalls: actual.byPurpose.main.calls,
      summaryCalls: actual.byPurpose.summary.calls, peakCalls: actual.byPeriod.peak.calls,
      offPeakCalls: actual.byPeriod['off-peak'].calls, crossTierCalls: lane.calls.filter(call => call.crossTier).length }
    keys(lane.expected, ['totals', 'byPurpose', 'byPeriod', 'counters', 'pricingBounds'])
    equal(actual.totals, lane.expected.totals, 'EXPECTED_TOTALS_MISMATCH')
    equal(actual.byPurpose, lane.expected.byPurpose, 'EXPECTED_PURPOSE_TOTALS_MISMATCH')
    equal(actual.byPeriod, lane.expected.byPeriod, 'EXPECTED_PERIOD_TOTALS_MISMATCH')
    equal(counters, lane.expected.counters, 'EXPECTED_COUNTERS_MISMATCH')
    keys(lane.expected.pricingBounds, ['lowerCny', 'upperCny', 'allOffPeakCny', 'allPeakCny'])
    Object.values(lane.expected.pricingBounds).forEach(decimal)
    const bound = lane.expected.pricingBounds
    if (!(Number(bound.lowerCny) <= Number(actual.totals.cost.totalCny) + 1e-9
      && Number(bound.upperCny) + 1e-9 >= Number(actual.totals.cost.totalCny))) fail('EXPECTED_BOUNDS_MISMATCH')
    for (const [field, choose] of [
      ['allOffPeakCny', () => 'off-peak'], ['allPeakCny', () => 'peak'],
      ['lowerCny', call => call.crossTier ? 'off-peak' : call.period],
      ['upperCny', call => call.crossTier ? 'peak' : call.period],
    ]) {
      const repriced = accountSessionUsage({ events, throughSeq: lane.throughSeq,
        periodsBySeq: Object.fromEntries(lane.calls.map(call => [call.seq, choose(call)])), pricesPerMillionCny: OFFICIAL_PRICES })
      equal(repriced.totals.cost.totalCny, bound[field], 'EXPECTED_REPRICING_BOUND_MISMATCH')
    }
    verified[laneName] = actual
  }
  return verified
}

/** Read only exported filenames and validate projection hashes before exact accounting. */
export function verifyReportFile(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const projections = {}
  for (const laneName of ['candidate', 'baseline']) {
    const lane = report.lanes?.[laneName]
    if (lane?.projectionFile !== `${laneName}.events.projected.jsonl`) fail('UNSAFE_PROJECTION_FILE')
    const bytes = readFileSync(join(dirname(reportPath), lane.projectionFile))
    if (createHash('sha256').update(bytes).digest('hex') !== lane.projectionSha256) fail('PROJECTION_HASH_MISMATCH')
    projections[laneName] = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line))
  }
  return verifyReportData(report, projections)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { report: { type: 'string' }, help: { type: 'boolean' } }, strict: true })
    if (values.help) console.log('Usage: node verify-report.mjs --report ACCOUNTING_REPORT_JSON')
    else {
      if (!values.report) fail('MISSING_REPORT_ARGUMENT')
      const result = verifyReportFile(values.report)
      console.log(JSON.stringify({ verified: true, currency: 'CNY', lanes: Object.fromEntries(Object.entries(result).map(([lane, value]) => [lane, {
        completedTurns: value.completedTurns, mainCalls: value.byPurpose.main.calls, summaryCalls: value.byPurpose.summary.calls,
        summaryOutputTokens: value.byPurpose.summary.usage.outputTokens, summaryOutputCny: value.byPurpose.summary.cost.outputCny,
        totalCny: value.totals.cost.totalCny,
      }])) }, null, 2))
    }
  } catch (error) {
    console.error(`Verification failed: ${typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : 'INVALID_REPORT_OR_IO'}`)
    process.exitCode = 1
  }
}
