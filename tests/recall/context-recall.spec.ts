import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Recall from '../../src/recall/index.ts'
import { decodeCursor, encodeCursor } from '../../src/recall/cursor.ts'
import type { Config } from '../../src/recall/config.ts'

interface Page {
  range: { startSeq: number; endSeq: number }
  records: Array<{
    seq: number; role: string; text: string; part: number; offset: number; isError?: boolean
    read?: { startSeq: number; part: number; offset: number }
    truncated?: boolean
  }>
  complete: boolean
  nextCursor?: string
  scannedEvents: number
  scannedCharacters: number
}

const contexts: Context[] = []

class HistoryQuery extends SessionQuery {
  override async searchSessions(): Promise<never> { throw new Error('unexpected full-text query') }
  override async searchEvents(): Promise<never> { throw new Error('unexpected full-text query') }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const meterFiber = await ctx.plugin(TokenMeter)
  await ctx.plugin(HistoryQuery)
  const fiber = await ctx.plugin(Recall, config)
  const agent = await ctx.agentLoop.create(SessionId('recall-caller'), { provider: 'mock', model: 'mock' })
  let calls = 0
  const call = (name: string, args: unknown, options: { agent?: Agent; signal?: AbortSignal; unbound?: boolean } = {}) => executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId(`recall-${++calls}`),
    ...options.unbound === true ? {} : { agent: options.agent ?? agent },
    signal: options.signal ?? new AbortController().signal,
  })
  return { ctx, fiber, meterFiber, agent, call }
}

function user(session: Session, text: string): SessionSeq {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function openCurrentStep(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
}

function content(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function page(result: ToolExecutionResult): Page {
  expect(result.isError, content(result)).toBe(false)
  return JSON.parse(content(result)) as Page
}

function code(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

describe('bounded original conversation recall', () => {
  it('keeps both complete tool schemas within a 200-token heuristic budget and supplies pure presenters', async () => {
    const h = await harness()
    const schemas = h.ctx.tools.schemas()
    expect(Math.ceil(JSON.stringify(schemas).length / 4) + 4).toBeLessThanOrEqual(200)
    const read = h.ctx.tools.get('context_read')
    const search = h.ctx.tools.get('context_search')
    expect(read?.presentCall?.({ startSeq: 1 })).toMatchObject({ card: 'generic', kind: 'read', rawInput: '1–1' })
    expect(read?.presentCall?.({ startSeq: 1, endSeq: 3 })).toMatchObject({ rawInput: '1–3' })
    expect(search?.presentCall?.({ query: 'literal' })).toMatchObject({ card: 'generic', kind: 'search', rawInput: 'literal' })
    expect(read?.isConcurrencySafe?.({ startSeq: 1 })).toBe(true)
    expect(search?.isConcurrencySafe?.({ query: 'literal' })).toBe(true)
  })

  it('reads the hidden original instead of its replacement and ignores other sessions', async () => {
    const h = await harness()
    const seq = user(h.agent.session, 'artifact-tag=azure-falcon-42; retry-limit=7')
    h.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'short summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    const other = await h.ctx.agentLoop.create(SessionId('other'), { provider: 'mock', model: 'mock' })
    user(other.session, 'private-other-session')
    openCurrentStep(h.agent.session)
    const read = page(await h.call('context_read', { startSeq: seq }))
    expect(read.records.map(item => item.text)).toEqual(['artifact-tag=azure-falcon-42; retry-limit=7'])
    const search = page(await h.call('context_search', { query: 'azure-falcon' }))
    expect(search.records[0]?.seq).toBe(seq)
    expect(content(await h.call('context_search', { query: 'private-other-session' }))).not.toContain('private-other-session')
    expect(h.agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('azure-falcon')))).toBe(false)
  })

  it('pages a single oversized Unicode event without losing characters or exceeding either complete-result budget', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const original = '甲🙂\\"\n'.repeat(400)
    const seq = user(h.agent.session, original)
    openCurrentStep(h.agent.session)
    let cursor: string | undefined
    let joined = ''
    let pages = 0
    do {
      const result = await h.call('context_read', { startSeq: seq, ...cursor === undefined ? {} : { cursor } })
      const text = content(result)
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024)
      expect(h.ctx.tokenMeter.estimateMessage(createToolResultMessage({ callId: ToolCallId('measured'), content: [{ type: 'text', text }], isError: false }))).toBeLessThanOrEqual(256)
      const current = page(result)
      expect(current.records.every(record => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(record.text))).toBe(true)
      joined += current.records.map(record => record.text).join('')
      cursor = current.nextCursor
      pages += 1
      expect(pages).toBeLessThan(200)
    } while (cursor !== undefined)
    expect(pages).toBeGreaterThan(1)
    expect(joined).toBe(original)
  })

  it('bounds search work and continues across a scan boundary to find an exact literal', async () => {
    const h = await harness({ maxScanCharacters: 1024, maxScanEvents: 2 })
    user(h.agent.session, 'a'.repeat(1020) + 'cross-boundary-needle' + 'z'.repeat(1200))
    user(h.agent.session, 'later needle')
    openCurrentStep(h.agent.session)
    const initial = page(await h.call('context_search', { query: 'cross-boundary-needle' }))
    expect(initial.complete).toBe(false)
    expect(initial.scannedCharacters).toBeLessThanOrEqual(1024)
    expect(initial.records).toEqual([])
    const next = page(await h.call('context_search', { query: 'cross-boundary-needle', cursor: initial.nextCursor }))
    expect(next.records[0]?.text).toContain('cross-boundary-needle')
    expect(next.scannedEvents).toBeLessThanOrEqual(2)
    expect(next.scannedCharacters).toBeLessThanOrEqual(1024)
  })

  it('searches fourteen ordinary large tool blocks in one default page and returns a complete matching JSON line', async () => {
    const h = await harness()
    const line = JSON.stringify({ category: 'target-entry', entries: Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}`, quantity: index + 1, status: 'accepted' })) })
    for (let index = 0; index < 14; index++) {
      h.agent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
        callId: ToolCallId(`large-${index}`), isError: false,
        content: [{ type: 'text', text: `${'unrelated observation\n'.repeat(2400)}${index === 11 ? line + '\n' : ''}` }],
      }) }, { surfaceOp: 'append' })
    }
    openCurrentStep(h.agent.session)
    const read = vi.spyOn(h.ctx.sessionQuery, 'readSession')
    const response = page(await h.call('context_search', { query: 'target-entry' }))
    expect(response.complete).toBe(true)
    expect(response.scannedCharacters).toBeGreaterThan(650_000)
    expect(response.scannedCharacters).toBeLessThanOrEqual(1_048_576)
    expect(response.records).toHaveLength(1)
    expect(response.records[0]?.text).toBe(line)
    expect(response.records[0]?.truncated).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)

    // Reintroduce the old scan cap over the same immutable history.
    await h.fiber.dispose()
    await h.ctx.plugin(Recall, { maxScanCharacters: 65536 })
    let cursor: string | undefined
    let calls = 0
    const found: string[] = []
    do {
      const previousCap = page(await h.call('context_search', { query: 'target-entry', ...cursor === undefined ? {} : { cursor } }))
      found.push(...previousCap.records.map(record => record.text))
      cursor = previousCap.nextCursor
      calls += 1
      expect(calls).toBeLessThanOrEqual(12)
    } while (cursor !== undefined)
    expect(calls).toBe(12)
    expect(found).toEqual([line])
  })

  it('returns every separated match in a text block and exposes exact read arguments for a distant text part', async () => {
    const h = await harness()
    const session = h.agent.session
    const prefix = '🙂 unrelated text\n'.repeat(4500)
    const first = JSON.stringify({ category: 'matched-record', value: 'first' })
    const second = JSON.stringify({ category: 'matched-record', value: 'second' })
    const original = `${prefix}${first}\n${'other line\n'.repeat(300)}${second}\n`
    const seq = session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'intro' }, { type: 'text', text: original }],
    }), { surfaceOp: 'append' }).seq
    openCurrentStep(session)
    const found = page(await h.call('context_search', { query: 'matched-record' }))
    expect(found.complete).toBe(true)
    expect(found.records.map(record => record.text)).toEqual([first, second])
    const hit = found.records[0]
    expect(hit?.read).toEqual({ startSeq: seq, part: 1, offset: prefix.length })
    const expanded = page(await h.call('context_read', hit?.read))
    expect(expanded.records[0]).toMatchObject({ seq, part: 1, offset: prefix.length })
    expect(expanded.records.map(record => record.text).join('')).toBe(original.slice(prefix.length))
  })

  it('resumes a search cursor without repeating its explicit range and still rejects a changed range', async () => {
    const h = await harness({ maxScanCharacters: 1024 })
    user(h.agent.session, 'outside range')
    const seq = user(h.agent.session, 'a'.repeat(1500) + '\nneedle located\n')
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_search', { query: 'needle', startSeq: seq, endSeq: seq }))
    const next = page(await h.call('context_search', { query: 'needle', cursor: first.nextCursor }))
    expect(next.range).toEqual({ startSeq: seq, endSeq: seq })
    expect(next.records[0]?.text).toBe('needle located')
    expect(code(await h.call('context_search', { query: 'needle', startSeq: 0, cursor: first.nextCursor }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
  })

  it('reports the available original range and rejects ambiguous or invalid text locations', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const seq = user(h.agent.session, '🙂' + 'x'.repeat(2000))
    openCurrentStep(h.agent.session)
    const boundary = h.ctx.agents.turnBoundaryOf(h.agent.session).lastStepStartSeq
    const invalidRange = await h.call('context_search', { query: 'x', endSeq: 400 })
    expect(code(invalidRange)).toBe('CONTEXT_RECALL_INVALID_RANGE')
    expect(content(invalidRange)).toContain(`0–${Number(boundary) - 1}`)
    expect(content(invalidRange)).toContain('omit')
    const first = page(await h.call('context_read', { startSeq: seq }))
    for (const location of [
      { offset: 1 }, { offset: -1 }, { part: 1 }, { offset: 9000 },
      { endSeq: seq + 1, part: 0 },
    ]) {
      expect(code(await h.call('context_read', { startSeq: seq, ...location }))).toBe('CONTEXT_RECALL_INVALID_POSITION')
    }
    expect(code(await h.call('context_read', { startSeq: seq, cursor: first.nextCursor, offset: 0 }))).toBe('CONTEXT_RECALL_INVALID_POSITION')
  })

  it('keeps later matches reachable when long snippets exhaust the complete-result budget', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const lines = Array.from({ length: 3 }, (_, index) => `needle-${index} ${'🙂 details '.repeat(180)}`)
    user(h.agent.session, lines.join('\n'))
    openCurrentStep(h.agent.session)
    let cursor: string | undefined
    const found: string[] = []
    do {
      const result = await h.call('context_search', { query: 'needle-', ...cursor === undefined ? {} : { cursor } })
      const rendered = content(result)
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(1024)
      expect(h.ctx.tokenMeter.estimateMessage(createToolResultMessage({ callId: ToolCallId('measured-search'), content: [{ type: 'text', text: rendered }], isError: false }))).toBeLessThanOrEqual(256)
      const current = page(result)
      for (const record of current.records) {
        expect(record.truncated).toBe(true)
        expect(record.read).toBeDefined()
        found.push(record.text.slice(0, 8))
      }
      cursor = current.nextCursor
      expect(found.length).toBeLessThanOrEqual(3)
    } while (cursor !== undefined)
    expect(found).toEqual(['needle-0', 'needle-1', 'needle-2'])
  })

  it('keeps search locations between Unicode scalars even for a literal matching one surrogate code unit', async () => {
    const h = await harness()
    user(h.agent.session, 'x'.repeat(600) + '🙂 retained suffix')
    openCurrentStep(h.agent.session)
    const found = page(await h.call('context_search', { query: '\uDE42' }))
    expect(found.records[0]).toMatchObject({ offset: 600, text: '🙂 retained suffix' })
    expect(page(await h.call('context_read', found.records[0]?.read)).records[0]?.text).toBe('🙂 retained suffix')
  })

  it('finishes in one page when the complete result fits without continuation metadata', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const original = 'x'.repeat(700)
    const seq = user(h.agent.session, original)
    openCurrentStep(h.agent.session)
    const response = page(await h.call('context_read', { startSeq: seq }))
    expect(response.complete).toBe(true)
    expect(response.records.map(record => record.text).join('')).toBe(original)
  })

  it('does not skip a match when the preceding event leaves less scan budget than the query length', async () => {
    const h = await harness({ maxScanCharacters: 1024 })
    user(h.agent.session, 'a'.repeat(1020))
    const seq = user(h.agent.session, 'exact-match-at-start' + 'z'.repeat(2000))
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_search', { query: 'exact-match-at-start' }))
    expect(first.complete).toBe(false)
    expect(first.records).toEqual([])
    const next = page(await h.call('context_search', { query: 'exact-match-at-start', cursor: first.nextCursor }))
    expect(next.records[0]).toMatchObject({ seq, offset: 0 })
    expect(next.records[0]?.text).toContain('exact-match-at-start')
  })

  it('reads every requested text block in order, labels tool failures, and excludes reasoning and system instructions', async () => {
    const h = await harness()
    const session = h.agent.session
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('never reveal system') }, { surfaceOp: 'append' })
    const start = user(session, 'first user')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant = createAssistantMessage({
      source: { provider: 'mock', model: 'mock' },
      content: [{ type: 'reasoning', text: 'private reasoning needle' }, { type: 'text', text: 'visible assistant' },
        { type: 'tool-call', id: ToolCallId('original-call'), name: 'test', arguments: '{"exact":7}' }],
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: ToolCallId('original-call'), content: [{ type: 'text', text: 'retained error text' }], isError: true,
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    const response = page(await h.call('context_read', { startSeq: 0, endSeq: result.seq }))
    expect(response.records.map(item => item.text)).toEqual(['first user', 'visible assistant', 'Tool call test: {"exact":7}', 'retained error text'])
    expect(response.records.at(-1)?.isError).toBe(true)
    expect(content(await h.call('context_search', { query: 'private reasoning' }))).not.toContain('private reasoning')
    expect(start).toBeGreaterThan(0)
  })

  it('rejects current-step reads, reversed ranges, malformed cursors and cross-session/query reuse', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const seq = user(h.agent.session, 'needle '.repeat(500))
    openCurrentStep(h.agent.session)
    const forbidden = user(h.agent.session, 'current step secret')
    expect(code(await h.call('context_read', { startSeq: forbidden }))).toBe('CONTEXT_RECALL_INVALID_RANGE')
    expect(code(await h.call('context_read', { startSeq: seq + 1, endSeq: seq }))).toBe('CONTEXT_RECALL_INVALID_RANGE')
    expect(code(await h.call('context_read', { startSeq: -1 }))).toBe('CONTEXT_RECALL_INVALID_RANGE')
    expect(code(await h.call('context_read', { startSeq: seq, cursor: '!' }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
    const read = page(await h.call('context_read', { startSeq: seq }))
    if (read.nextCursor === undefined) throw new Error('expected partial read')
    const parsed = decodeCursor(read.nextCursor)
    expect(code(await h.call('context_read', { startSeq: seq, cursor: encodeCursor({ ...parsed, offset: Number.MAX_SAFE_INTEGER }) }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
    const other = await h.ctx.agentLoop.create(SessionId('other-caller'), { provider: 'mock', model: 'mock' })
    user(other.session, 'other'.repeat(1000))
    openCurrentStep(other.session)
    expect(code(await h.call('context_read', { startSeq: seq, cursor: read.nextCursor }, { agent: other }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
    expect(code(await h.call('context_search', { query: 'needle', cursor: read.nextCursor }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
    expect(code(await h.call('context_search', { query: '' }))).toBe('CONTEXT_RECALL_INVALID_QUERY')
    expect(code(await h.call('context_search', { query: 'x'.repeat(257) }))).toBe('CONTEXT_RECALL_INVALID_QUERY')
    expect(code(await h.call('context_read', { startSeq: seq }, { unbound: true }))).toBe('CONTEXT_RECALL_MISSING_AGENT')
  })

  it('returns explicit no-match coverage and respects an event-count page cap', async () => {
    const h = await harness({ maxScanEvents: 1 })
    user(h.agent.session, 'one')
    user(h.agent.session, 'two')
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_search', { query: 'missing' }))
    expect(first).toMatchObject({ records: [], complete: false, scannedEvents: 1 })
    const second = page(await h.call('context_search', { query: 'missing', cursor: first.nextCursor }))
    expect(second).toMatchObject({ records: [], complete: false, scannedEvents: 1 })
    const third = page(await h.call('context_search', { query: 'missing', cursor: second.nextCursor }))
    expect(third).toMatchObject({ records: [], complete: true, scannedEvents: 1 })
  })

  it('preserves cancellation and removes tools when the plugin fiber is disposed', async () => {
    const h = await harness()
    const seq = user(h.agent.session, 'old text')
    openCurrentStep(h.agent.session)
    const controller = new AbortController()
    controller.abort(new Error('stop recall'))
    const result = await h.call('context_read', { startSeq: seq }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(content(result)).not.toContain('old text')
    expect(h.ctx.tools.schemas().map(schema => schema.name)).toEqual(['context_read', 'context_search'])
    await h.fiber.dispose()
    expect(h.ctx.tools.schemas()).toEqual([])
    expect('default' in Recall).toBe(false)
  })

  it('loads exactly one public history snapshot per call and cancellation after that read suppresses all transcript text', async () => {
    const h = await harness()
    const seq = user(h.agent.session, 'before abort secret')
    openCurrentStep(h.agent.session)
    const read = h.ctx.sessionQuery.readSession.bind(h.ctx.sessionQuery)
    const controller = new AbortController()
    const spy = vi.spyOn(h.ctx.sessionQuery, 'readSession').mockImplementation(async id => {
      const snapshot = await read(id)
      controller.abort(new Error('cancel after snapshot'))
      return snapshot
    })
    const result = await h.call('context_read', { startSeq: seq }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(content(result)).not.toContain('before abort secret')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('settles an admitted recall after its registration unloads and denies new calls', async () => {
    const h = await harness()
    const seq = user(h.agent.session, 'accepted history')
    openCurrentStep(h.agent.session)
    const read = h.ctx.sessionQuery.readSession.bind(h.ctx.sessionQuery)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(h.ctx.sessionQuery, 'readSession').mockImplementation(async id => {
      const snapshot = await read(id)
      entered.resolve()
      await release.promise
      return snapshot
    })
    const active = h.call('context_read', { startSeq: seq })
    try {
      await entered.promise
      await h.fiber.dispose()
      expect(h.ctx.tools.schemas()).toEqual([])
      expect(code(await h.call('context_read', { startSeq: seq }))).toBe('UNKNOWN_TOOL')
    } finally {
      release.resolve()
    }
    expect(page(await active).records[0]?.text).toBe('accepted history')
  })

  it('finishes already admitted text recall when the estimator provider is withdrawn during its historical read', async () => {
    const h = await harness()
    const seq = user(h.agent.session, 'preserved through provider withdrawal')
    openCurrentStep(h.agent.session)
    const read = h.ctx.sessionQuery.readSession.bind(h.ctx.sessionQuery)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(h.ctx.sessionQuery, 'readSession').mockImplementation(async id => {
      const snapshot = await read(id)
      entered.resolve()
      await release.promise
      return snapshot
    })
    const active = h.call('context_read', { startSeq: seq })
    try {
      await entered.promise
      await h.meterFiber.dispose()
      expect(h.ctx.tools.schemas()).toEqual([])
    } finally {
      release.resolve()
    }
    expect(page(await active).records[0]?.text).toBe('preserved through provider withdrawal')
  })

  it('continues an old search snapshot range after a later step adds more matching text', async () => {
    const h = await harness({ maxScanEvents: 1 })
    user(h.agent.session, 'needle old one')
    user(h.agent.session, 'needle old two')
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_search', { query: 'needle' }))
    h.agent.session.append('step/end', { turn: 1, step: 1 })
    user(h.agent.session, 'needle newly admitted')
    h.agent.session.append('step/start', { turn: 1, step: 2 })
    let cursor = first.nextCursor
    const found = [...first.records]
    while (cursor !== undefined) {
      const next = page(await h.call('context_search', { query: 'needle', cursor }))
      expect(next.range).toEqual(first.range)
      found.push(...next.records)
      cursor = next.nextCursor
    }
    expect(found.map(record => record.text)).toEqual(['needle old one', 'needle old two'])
  })

  it('handles empty text and log-only ranges, and never emits an unbounded search snippet', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024, snippetCharacters: 5000 })
    const empty = user(h.agent.session, '')
    user(h.agent.session, 'needle🙂'.repeat(600))
    h.agent.session.append('turn/start', { turn: 1 })
    const boundary = h.agent.session.append('step/start', { turn: 1, step: 1 }).seq
    expect(page(await h.call('context_read', { startSeq: empty }))).toMatchObject({ records: [], complete: true })
    expect(page(await h.call('context_read', { startSeq: boundary - 1 }))).toMatchObject({ records: [], complete: true })
    const result = await h.call('context_search', { query: 'needle' })
    expect(Buffer.byteLength(content(result), 'utf8')).toBeLessThanOrEqual(1024)
    expect(page(result).records[0]?.text).toContain('needle')
  })

  it('rejects malformed cursor fields and a text offset inside a Unicode code point', async () => {
    const h = await harness({ maxOutputTokens: 256, maxOutputBytes: 1024 })
    const seq = user(h.agent.session, '🙂'.repeat(700))
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_read', { startSeq: seq }))
    if (first.nextCursor === undefined) throw new Error('expected partial read')
    const position = decodeCursor(first.nextCursor)
    const { owner, ...payload } = position
    const rawCursor = (value: unknown): string => `${owner}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`
    for (const cursor of [
      encodeCursor({ ...position, part: 999 }),
      encodeCursor({ ...position, offset: 1 }),
      rawCursor({}), rawCursor(null), rawCursor([]),
      `${owner}.${Buffer.from('not JSON').toString('base64url')}`,
      rawCursor({ ...payload, seq: -1 }), rawCursor({ ...payload, mode: 'other' }),
      rawCursor({ ...payload, query: 'invalid' }), rawCursor({ ...payload, seq: payload.to + 1 }),
      'x'.repeat(1025),
    ]) {
      expect(code(await h.call('context_read', { startSeq: seq, cursor }))).toBe('CONTEXT_RECALL_INVALID_CURSOR')
    }
  })

  it('rejects recall before any step and preserves a normalized session identity in continuation tokens', async () => {
    const h = await harness()
    expect(code(await h.call('context_search', { query: 'old' }))).toBe('CONTEXT_RECALL_INVALID_RANGE')
    const seq = user(h.agent.session, 'old'.repeat(4000))
    openCurrentStep(h.agent.session)
    const first = page(await h.call('context_read', { startSeq: seq }))
    if (first.nextCursor === undefined) throw new Error('expected partial read')
    expect(first.nextCursor.startsWith(h.agent.session.id + '.')).toBe(true)
    const normalized = first.nextCursor.replace(h.agent.session.id, 'normalized-session')
    expect(decodeCursor(normalized).owner).toBe('normalized-session')
  })

  it.each([
    { maxOutputTokens: 255 }, { maxOutputBytes: 1023 }, { maxScanEvents: 0 },
    { maxScanCharacters: 1023 }, { maxQueryCharacters: 0 }, { snippetCharacters: 0 },
    { maxQueryCharacters: 2048, maxScanCharacters: 1024 },
  ])('rejects invalid deployment limits %j', async config => {
    await expect(harness(config)).rejects.toThrow(new RegExp(Object.keys(config)[0] ?? 'context recall'))
  })
})
