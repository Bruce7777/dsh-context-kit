/** Exact offline CNY accounting for a completed prefix of raw DSH Session events. */

const PERIODS = new Set(['peak', 'off-peak'])
const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const COMPONENTS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']

/** A rejected or unpriceable prefix; diagnostics contain no message or error text. */
export class UsageAccountingError extends Error {
  constructor(code, seq) {
    super(`Usage accounting: ${code}${seq === undefined ? '' : ` at seq ${seq}`}`)
    this.name = 'UsageAccountingError'
    this.code = code
    this.seq = seq
  }
}

function fail(code, seq) { throw new UsageAccountingError(code, seq) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function integer(value, code, seq) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, seq)
  return value
}
function decimal(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/u.test(value)) fail('INVALID_DECIMAL_PRICE')
  const [whole, fraction = ''] = value.split('.')
  return { units: BigInt(whole + fraction), scale: fraction.length }
}
function plus(a, b) {
  const scale = Math.max(a.scale, b.scale)
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale }
}
function formatted(value) {
  if (value.units === 0n) return '0'
  const digits = value.units.toString().padStart(value.scale + 1, '0')
  return value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/0+$/u, '').replace(/\.$/u, '')
}
function zero() { return { units: 0n, scale: 0 } }
function group() { return { calls: 0, tokens: TOKEN_FIELDS.map(() => 0n), costs: COMPONENTS.map(zero) } }
function add(group, usage, costs) {
  group.calls += 1
  TOKEN_FIELDS.forEach((field, i) => { group.tokens[i] += BigInt(usage[field]); group.costs[i] = plus(group.costs[i], costs[i]) })
}
function safeNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('UNSAFE_AGGREGATE_TOKENS')
  return Number(value)
}
function output(group) {
  const usage = Object.fromEntries(TOKEN_FIELDS.map((field, i) => [field, safeNumber(group.tokens[i])]))
  usage.allInputTokens = safeNumber(group.tokens[0] + group.tokens[1] + group.tokens[2])
  usage.totalTokens = safeNumber(group.tokens.reduce((a, b) => a + b, 0n))
  const cost = Object.fromEntries(COMPONENTS.map((name, i) => [`${name}Cny`, formatted(group.costs[i])]))
  cost.totalCny = formatted(group.costs.reduce(plus, zero()))
  return { calls: group.calls, usage, cost }
}
function readUsage(value, seq) {
  if (!object(value)) fail('MISSING_USAGE', seq)
  const usage = {}
  for (const field of TOKEN_FIELDS) {
    if (!Object.hasOwn(value, field)) fail('MISSING_USAGE_FIELD', seq)
    usage[field] = integer(value[field], 'INVALID_TOKEN_COUNT', seq)
  }
  if (value.totalTokens !== undefined) {
    integer(value.totalTokens, 'INVALID_TOKEN_COUNT', seq)
    if (BigInt(value.totalTokens) !== TOKEN_FIELDS.reduce((sum, field) => sum + BigInt(usage[field]), 0n)) fail('INCONSISTENT_TOTAL_TOKENS', seq)
  }
  if (value.reasoningTokens !== undefined) {
    usage.reasoningTokens = integer(value.reasoningTokens, 'INVALID_TOKEN_COUNT', seq)
    if (usage.reasoningTokens > usage.outputTokens) fail('REASONING_EXCEEDS_OUTPUT', seq)
  }
  return usage
}
function readPrices(cards) {
  if (!object(cards)) fail('INVALID_PRICES')
  return Object.fromEntries(Object.entries(cards).map(([period, card]) => {
    if (!PERIODS.has(period) || !object(card)) fail('INVALID_PRICE_PERIOD')
    if (Object.keys(card).some(key => !COMPONENTS.includes(key))) fail('UNKNOWN_PRICE_COMPONENT')
    const prices = { uncachedInput: decimal(card.uncachedInput), cacheRead: decimal(card.cacheRead), output: decimal(card.output) }
    if (card.cacheWrite !== undefined) prices.cacheWrite = decimal(card.cacheWrite)
    return [period, prices]
  }))
}

/**
 * Account every main and summary call in an explicitly completed raw prefix.
 * @param options.events - original parsed events with consecutive seq starting at 0; never filtered or resequenced.
 * @param options.throughSeq - inclusive cutoff; later in-flight events are outside this declared scope.
 * @param options.periodsBySeq - explicit own-property mapping from each usage event seq to peak or off-peak; no time inference.
 * @param options.pricesPerMillionCny - decimal-string prices per million disjoint uncachedInput/cacheRead/output tokens, plus cacheWrite when nonzero.
 * @returns per-call and grouped exact decimal CNY strings, including summary output and subsequent refill calls.
 * @throws UsageAccountingError for incomplete lifecycles, unknown usage/prices, unsafe counts or an unfinished/failed turn.
 */
export function accountSessionUsage({ events, throughSeq, periodsBySeq, pricesPerMillionCny }) {
  integer(throughSeq, 'INVALID_CUTOFF')
  if (!Array.isArray(events) || throughSeq >= events.length || !object(periodsBySeq)) fail('INVALID_PREFIX')
  const prices = readPrices(pricesPerMillionCny)
  const all = group(), byPurpose = { main: group(), summary: group() }, byPeriod = { peak: group(), 'off-peak': group() }
  const calls = [], compactions = [], active = new Map(), seen = new Set()
  let turn = null, completedTurns = 0
  function bill(event, purpose) {
    const usage = readUsage(event.data.usage, event.seq)
    if (!Object.hasOwn(periodsBySeq, event.seq) || !PERIODS.has(periodsBySeq[event.seq])) fail('MISSING_OR_INVALID_PERIOD', event.seq)
    const period = periodsBySeq[event.seq], rates = prices[period]
    if (rates === undefined) fail('MISSING_PRICE_CARD', event.seq)
    if (usage.cacheWriteTokens > 0 && rates.cacheWrite === undefined) fail('CACHE_WRITE_UNPRICED', event.seq)
    const costs = TOKEN_FIELDS.map((field, i) => {
      const rate = rates[COMPONENTS[i]]
      return rate === undefined ? zero() : { units: BigInt(usage[field]) * rate.units, scale: rate.scale + 6 }
    })
    const one = group(); add(one, usage, costs)
    const row = { seq: event.seq, type: event.type, purpose, period, ...output(one) }
    if (purpose === 'summary') row.compactionId = event.data.compactionId
    if (usage.reasoningTokens !== undefined) row.reasoningTokensIncludedInOutput = usage.reasoningTokens
    calls.push(row)
    add(all, usage, costs); add(byPurpose[purpose], usage, costs); add(byPeriod[period], usage, costs)
  }
  function identity(data, seq) {
    if (typeof data.compactionId !== 'string' || data.compactionId.length === 0) fail('INVALID_COMPACTION_ID', seq)
    return data.compactionId
  }
  for (let seq = 0; seq <= throughSeq; seq += 1) {
    const event = events[seq]
    if (!object(event) || event.seq !== seq || typeof event.type !== 'string' || !object(event.data)) fail('NONCONTIGUOUS_OR_INVALID_EVENT', seq)
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        integer(data.turn, 'INVALID_TURN', seq)
        if (data.turn === 0 || turn !== null) fail('INVALID_TURN_START', seq)
        turn = data.turn
        break
      case 'assistant/message':
        if (turn === null || data.turn !== turn) fail('MAIN_CALL_OUTSIDE_TURN', seq)
        bill(event, 'main')
        break
      case 'assistant/attempt':
        fail('ATTEMPT_USAGE_UNSUPPORTED', seq)
        break
      case 'compaction/start': {
        const id = identity(data, seq)
        if (seen.has(id) || active.size > 0) fail('DUPLICATE_OR_OVERLAPPING_COMPACTION', seq)
        if (data.turn !== turn) fail('COMPACTION_OWNER_MISMATCH', seq)
        seen.add(id); active.set(id, { startSeq: seq, turn: data.turn, summarySeq: null })
        break
      }
      case 'compaction/summary': {
        const state = active.get(identity(data, seq))
        if (state === undefined) fail('UNMATCHED_SUMMARY', seq)
        if (state.summarySeq !== null) fail('DUPLICATE_SUMMARY', seq)
        bill(event, 'summary'); state.summarySeq = seq
        break
      }
      case 'compaction/end': {
        const id = identity(data, seq), state = active.get(id)
        if (state === undefined) fail('UNMATCHED_COMPACTION_END', seq)
        if (state.turn !== data.turn || data.turn !== turn) fail('COMPACTION_OWNER_MISMATCH', seq)
        if (state.summarySeq === null) fail(data.error === undefined ? 'MISSING_SUMMARY' : 'FAILED_SUMMARY_USAGE_UNKNOWN', seq)
        compactions.push({ compactionId: id, startSeq: state.startSeq, summarySeq: state.summarySeq, endSeq: seq, status: data.error === undefined ? 'completed' : 'failed-with-recorded-usage' })
        active.delete(id)
        break
      }
      case 'turn/end':
        if (turn === null || data.turn !== turn) fail('UNMATCHED_TURN_END', seq)
        if (active.size > 0) fail('OPEN_COMPACTION_AT_TURN_END', seq)
        if (!object(data.reason) || data.reason.kind !== 'completed') fail('INCOMPLETE_OR_FAILED_TURN', seq)
        completedTurns += 1; turn = null
        break
      default:
        // Non-billing Session events remain in the prefix to preserve sequence coverage.
        break
    }
  }
  if (active.size > 0) fail('UNCLOSED_COMPACTION', throughSeq)
  if (turn !== null || completedTurns === 0) fail('INCOMPLETE_PREFIX', throughSeq)
  return { throughSeq, completedTurns, calls, compactions, totals: output(all), byPurpose: Object.fromEntries(Object.entries(byPurpose).map(([key, value]) => [key, output(value)])), byPeriod: Object.fromEntries(Object.entries(byPeriod).map(([key, value]) => [key, output(value)])), currency: 'CNY', priceUnit: 'per-million-tokens', reasoningBilledSeparately: false }
}
