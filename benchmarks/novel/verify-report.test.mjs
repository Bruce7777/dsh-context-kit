import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const exporter = fileURLToPath(new URL('./export-accounting.mjs', import.meta.url))
const verifier = fileURLToPath(new URL('./verify-report.mjs', import.meta.url))
const source = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const initialTime = Date.parse('2026-11-09T09:59:55.000Z')
const markers = ['PRIVATE_SYNTHETIC_TEXT', 'PRIVATE_SYNTHETIC_REASONING', 'PRIVATE_SYNTHETIC_ARGUMENTS', 'PRIVATE_SYNTHETIC_LOCATION', 'PRIVATE_SYNTHETIC_SESSION', 'private-source-summary-id']

function usage(inputTokens, cacheReadTokens, outputTokens, reasoningTokens = 0) {
  return { inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens, reasoningTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens }
}

/** Fixed counters and independently stated fees exercise one complete turn and an unpriced later tail. */
function laneFixture(summary, unknownAttempt = false) {
  const main = usage(1_000_000, 0, 100_000, 40_000)
  const auxiliary = usage(100_000, 900_000, 20_000, 5_000)
  const refill = usage(300_000, 100_000, 10_000, 2_000)
  const events = [
    { type: 'permission/preset', data: { preset: 'workspace-write', cwd: markers[3], sessionId: markers[4], arguments: markers[2] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 256000, temperature: 0.5 }, tools: [{ description: markers[2] }] } } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: markers[4] }, content: [{ type: 'text', text: markers[0] }] } },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: main,
      message: { content: [{ type: 'text', text: markers[0] }] }, stream: [{ type: 'reasoning-chunks', texts: [markers[1]] }] } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ]
  if (summary) events.push(
    { type: 'compaction/start', data: { turn: 1, compactionId: markers[5] } },
    { type: 'compaction/summary', data: { compactionId: markers[5], provider: 'deepseek-official', model: 'deepseek-flash',
      usage: auxiliary, summary: [{ type: 'text', text: markers[0] }], rawOutput: [{ type: 'reasoning', text: markers[1] }] } },
    { type: 'user/message', data: { source: { kind: 'compact-checkpoint', compactionId: markers[5] }, content: [{ type: 'text', text: markers[0] }] } },
    { type: 'compaction/end', data: { turn: 1, compactionId: markers[5] } },
  )
  events.push(
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'assistant/message', data: { turn: 1, step: 2, usage: refill } },
    { type: 'step/end', data: { turn: 1, step: 2 } },
  )
  if (unknownAttempt) events.push({ type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [], error: markers[1] } })
  events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const raw = events.map((event, seq) => ({ seq, time: initialTime + seq * 1000, ...event }))
  const throughSeq = raw.length - 1
  const first = raw.find(event => event.type === 'assistant/message')
  const last = raw.findLast(event => event.type === 'assistant/message')
  const firstCall = { round: 1, type: first.type, seq: first.seq, startAt: new Date(raw[2].time).toISOString(), endAt: new Date(first.time).toISOString(),
    timingBasis: 'start-marker', tier: 'peak', crossTier: true, usage: main,
    components: { uncachedInput: 2, cacheRead: 0, output: 0.8 }, estimatedCny: 2.8 }
  const refillCall = { round: 1, type: last.type, seq: last.seq, startAt: new Date(raw[last.seq - 1].time).toISOString(), endAt: new Date(last.time).toISOString(),
    timingBasis: 'start-marker', tier: 'off-peak', crossTier: false, usage: refill,
    components: { uncachedInput: 0.3, cacheRead: 0.002, output: 0.04 }, estimatedCny: 0.342 }
  const calls = [firstCall]
  if (summary) {
    const event = raw.find(event => event.type === 'compaction/summary')
    calls.push({ round: 1, type: event.type, seq: event.seq, startAt: new Date(raw[event.seq - 1].time).toISOString(), endAt: new Date(event.time).toISOString(),
      timingBasis: 'start-marker', tier: 'off-peak', crossTier: false, usage: auxiliary,
      components: { uncachedInput: 0.1, cacheRead: 0.018, output: 0.08 }, estimatedCny: 0.198 })
  }
  calls.push(refillCall)
  const total = summary
    ? { uncachedInputCny: 2.4, cachedInputCny: 0.02, outputCny: 0.92, estimatedCny: 3.34, lowerCny: 1.94, upperCny: 3.34,
        allOffPeakCny: 1.94, allPeakCny: 3.88, peakCalls: 1, offPeakCalls: 2, crossTierCalls: 1 }
    : { uncachedInputCny: 2.3, cachedInputCny: 0.002, outputCny: 0.84, estimatedCny: 3.142, lowerCny: 1.742, upperCny: 3.142,
        allOffPeakCny: 1.742, allPeakCny: 3.484, peakCalls: 1, offPeakCalls: 1, crossTierCalls: 1 }
  raw.push(
    { seq: raw.length, time: initialTime + (throughSeq + 1) * 1000, type: 'turn/start', data: { turn: 2 } },
    { seq: raw.length + 1, time: initialTime + (throughSeq + 2) * 1000, type: 'assistant/attempt', data: { turn: 2, step: 1, stream: [] } },
  )
  return { events: raw, throughSeq, calls, total }
}

function withRun(callback, unknownAttempt = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-public-accounting-'))
  try {
    const runDirectory = join(root, 'run')
    const outputDirectory = join(root, 'export')
    mkdirSync(runDirectory)
    const candidate = laneFixture(true, unknownAttempt)
    const baseline = laneFixture(false)
    writeFileSync(join(runDirectory, 'progress.json'), JSON.stringify({ turns: [
      { port: 3080, round: 1, throughSeq: candidate.throughSeq }, { port: 3082, round: 1, throughSeq: baseline.throughSeq },
    ] }))
    writeFileSync(join(runDirectory, 'cost-through-001.json'), JSON.stringify({ throughRound: 1, model: 'deepseek-flash', currency: 'CNY', source,
      lanes: { 3080: { calls: candidate.calls, total: candidate.total }, 3082: { calls: baseline.calls, total: baseline.total } } }))
    for (const [port, fixture] of [[3080, candidate], [3082, baseline]]) {
      writeFileSync(join(runDirectory, `events-${port}.jsonl`), fixture.events.map(event => JSON.stringify(event)).join('\n') + '\n')
    }
    return callback({ root, runDirectory, outputDirectory, candidate, baseline })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function cli(script, args, root) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return result
}
function exportCli(run) {
  return cli(exporter, ['--run-dir', run.runDirectory, '--through', '1', '--out', run.outputDirectory], run.root)
}
function verifyCli(run) {
  return cli(verifier, ['--report', join(run.outputDirectory, 'accounting-report.json')], run.root)
}
function exported(run) {
  const result = exportCli(run)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(readFileSync(join(run.outputDirectory, 'accounting-report.json'), 'utf8'))
}

/** Rehash mutations so failures exercise payload/accounting checks, not hash mismatch alone. */
function changeProjection(run, change) {
  const path = join(run.outputDirectory, 'accounting-report.json')
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const lane = report.lanes.candidate
  const projection = join(run.outputDirectory, lane.projectionFile)
  const events = readFileSync(projection, 'utf8').trim().split('\n').map(JSON.parse)
  change(events)
  const contents = events.map(event => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(projection, contents)
  lane.projectionSha256 = createHash('sha256').update(contents).digest('hex')
  writeFileSync(path, JSON.stringify(report))
}
function refused(result, prefix, code) {
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), `${prefix} failed: ${code}`)
}

test('export and verify CLIs retain summary output, refill charges and an explicit completed cutoff', () => withRun(run => {
  const report = exported(run)
  const result = verifyCli(run)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const verified = JSON.parse(result.stdout)
  assert.deepEqual(verified.lanes.candidate, { completedTurns: 1, mainCalls: 2, summaryCalls: 1, summaryOutputTokens: 20_000, summaryOutputCny: '0.08', totalCny: '3.34' })
  assert.deepEqual(verified.lanes.baseline, { completedTurns: 1, mainCalls: 2, summaryCalls: 0, summaryOutputTokens: 0, summaryOutputCny: '0', totalCny: '3.142' })
  assert.equal(report.notice, '仅用于费用审计的字段投影，不是可重放的Session日志')
  assert.equal(report.lanes.candidate.expected.byPurpose.main.cost.totalCny, '3.142')
  assert.equal(report.lanes.candidate.expected.byPurpose.summary.cost.totalCny, '0.198')
  assert.equal(report.lanes.candidate.calls.at(-1).expectedCost.uncachedInputCny, '0.3')
  assert.deepEqual(report.lanes.candidate.calls.map(call => call.period), ['peak', 'off-peak', 'off-peak'])
  assert.equal(report.lanes.candidate.expected.pricingBounds.lowerCny, '1.94')
  for (const [name, fixture] of [['candidate', run.candidate], ['baseline', run.baseline]]) {
    const lane = report.lanes[name]
    const events = readFileSync(join(run.outputDirectory, lane.projectionFile), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(events.length, fixture.throughSeq + 1)
    assert.deepEqual(events.map(({ seq, type, time }) => ({ seq, type, time })), fixture.events.slice(0, fixture.throughSeq + 1).map(({ seq, type, time }) => ({ seq, type, time })))
    assert(!events.some(event => event.type === 'assistant/attempt'))
    assert.equal(lane.sourceFileSha256, createHash('sha256').update(readFileSync(join(run.runDirectory, `events-${name === 'candidate' ? 3080 : 3082}.jsonl`))).digest('hex'))
  }
  const candidateEvents = readFileSync(join(run.outputDirectory, report.lanes.candidate.projectionFile), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(candidateEvents.filter(event => event.data.compactionId !== undefined).map(event => event.data.compactionId), ['compact001', 'compact001', 'compact001'])
  for (const file of readdirSync(run.outputDirectory)) {
    const text = readFileSync(join(run.outputDirectory, file), 'utf8')
    for (const marker of markers) assert(!text.includes(marker))
    assert(!text.includes(run.root))
    assert(!/"(?:content|stream|message|arguments|cwd|sessionId|tools)"\s*:/u.test(text))
  }
}))

test('verify CLI rejects missing summary output even after projection hash is updated', () => withRun(run => {
  exported(run)
  changeProjection(run, events => { delete events.find(event => event.type === 'compaction/summary').data.usage.outputTokens })
  refused(verifyCli(run), 'Verification', 'MISSING_USAGE_FIELD')
}))

test('verify CLI rejects zeroed summary output with an otherwise consistent provider total', () => withRun(run => {
  exported(run)
  changeProjection(run, events => {
    const value = events.find(event => event.type === 'compaction/summary').data.usage
    value.outputTokens = 0
    value.reasoningTokens = 0
    value.totalTokens = value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens
  })
  refused(verifyCli(run), 'Verification', 'EXPECTED_CALL_COST_MISMATCH')
}))

test('verify CLI refuses an inserted message payload instead of displaying its contents', () => withRun(run => {
  exported(run)
  changeProjection(run, events => { events.find(event => event.type === 'compaction/summary').data.message = { content: markers[0] } })
  refused(verifyCli(run), 'Verification', 'FORBIDDEN_FIELD')
}))

test('verify CLI refuses removed source events without resequencing the remaining projection', () => withRun(run => {
  exported(run)
  changeProjection(run, events => { events.splice(0, 1) })
  refused(verifyCli(run), 'Verification', 'WRONG_PROJECTION_CUT')
}))

test('verify CLI refuses reordered source events with their original sequence numbers', () => withRun(run => {
  exported(run)
  changeProjection(run, events => { [events[0], events[1]] = [events[1], events[0]] })
  refused(verifyCli(run), 'Verification', 'INVALID_EVENT')
}))

test('export CLI refuses an unknown-cost assistant attempt inside the declared completed prefix', () => withRun(run => {
  refused(exportCli(run), 'Export', 'UNSUPPORTED_ATTEMPT_ACCOUNTING')
  assert.equal(existsSync(join(run.outputDirectory, 'accounting-report.json')), false)
}, true))

test('verify CLI refuses an unknown-cost attempt even when its projection hash is valid', () => withRun(run => {
  exported(run)
  changeProjection(run, events => { events[0] = { seq: events[0].seq, time: events[0].time, type: 'assistant/attempt', data: { turn: 1, step: 1 } } })
  refused(verifyCli(run), 'Verification', 'UNSUPPORTED_ATTEMPT_ACCOUNTING')
}))
