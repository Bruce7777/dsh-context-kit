import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import BudgetedCompactionEngine from '../../src/budgeted/index.js'
import type { BudgetedCompactionConfig } from '../../src/budgeted/types.js'
import { budgetHistory } from '../integration/budget-history.js'

class SummaryAdapter extends LlmAdapter {
  readonly summaries: GenerateOptions[] = []
  readonly contextWindows: Record<string, number> = {}
  readonly reasoningEfforts: Record<string, readonly ReasoningEffortId[]> = {}
  failure: Error | undefined
  gate: Promise<void> | undefined
  onStart: (() => void) | undefined
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const efforts = this.reasoningEfforts[`${provider}/${model}`] ?? ['off', 'high', 'max'].map(ReasoningEffortId)
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindows[model] ?? 1048576 }, defaultMaxTokens: 8192,
      reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: efforts.includes(ReasoningEffortId('high')) ? ReasoningEffortId('high') : efforts[0] } })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.summaries.push(options)
    this.onStart?.()
    if (this.gate !== undefined) await this.gate
    if (this.failure !== undefined) throw this.failure
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Keep investigating builds. Preserve the user restriction and retrieve original exact release values when needed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(config: BudgetedCompactionConfig = {}, recall = true, steps = 8, meta?: SessionEvent<'tool/result'>['data']['meta']) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new SummaryAdapter()
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  if (recall) for (const name of ['context_read', 'context_search']) ctx.tools.register(defineTool({
    name, description: 'Read archived synthetic history.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('original history'),
  }))
  await ctx.plugin(BudgetedCompactionEngine, { auto: false, pruneToolResults: true, headroomTokens: 0,
    maxContextTokens: 100000, toolHistoryTokens: 2400, retainTokens: 1024,
    protectedSteps: 2, minSavingsTokens: 128, summaryTargetTokens: 512, ...config })
  const seed = meta === undefined ? budgetHistory(steps) : budgetHistory(steps).map(event => event.type === 'tool/result'
    ? { ...event, data: { ...event.data, meta } } : event)
  const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('budget-policy'), seed,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const committed: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) committed.push(event) })
  agent.session.append('turn/start', { turn: 2 })
  return { ctx, agent, adapter, committed, seed, engine: ctx.compaction as BudgetedCompactionEngine }
}

const signal = (): AbortSignal => new AbortController().signal
const streamListenerCount = (ctx: Context): number => ctx.events.dispatch('waterfall', [ctx.llm, 'llm/stream']).length

describe('budget compaction policy through public host services', () => {
  it('reduces accumulated smaller tool results while keeping recent and error outputs verbatim', async () => {
    const { ctx, agent, engine, committed, seed, adapter } = await harness()
    const before = ctx.tokenMeter.measure(agent.session).totalTokens
    expect(await engine.compactIfNeeded(agent, 'pressure', signal())).toBeNull()
    const replacements = committed.filter(event => event.type === 'tool/result')
    expect(replacements.length).toBeGreaterThan(0)
    expect(replacements.every(event => event.data.step <= 6 && event.data.step !== 3)).toBe(true)
    for (const event of replacements) {
      const source = seed.find(original => original.seq === event.sourceEventSeqs?.[0])
      if (source?.type !== 'tool/result') throw new Error('replacement did not cite a tool-result original')
      expect(event.data.message.id).toBe(source.data.message.id)
      expect(event.data.message.source).toEqual(source.data.message.source)
      expect(event.data.message.isError).toBe(source.data.message.isError)
      expect(JSON.stringify(event.data.message.content)).toContain(`context_read({\\"startSeq\\":${source.seq}})`)
    }
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(before)
    expect(adapter.summaries).toHaveLength(0)
    const count = committed.length
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(committed).toHaveLength(count)
  })

  it('keeps all history when a proposed batch is below its minimum saving', async () => {
    const { engine, agent, committed } = await harness({ minSavingsTokens: 90000 })
    const count = committed.length
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(committed).toHaveLength(count)
  })

  it('fails before mutation when recall tools are unavailable', async () => {
    const { engine, agent, committed } = await harness({}, false)
    const count = committed.length
    await expect(engine.compactIfNeeded(agent, 'pressure', signal())).rejects.toMatchObject({ code: 'CONTEXT_RECALL_UNAVAILABLE' })
    expect(committed).toHaveLength(count)
  })

  it('preserves the exact cancellation reason and commits no reduction', async () => {
    const { engine, agent, committed } = await harness()
    const controller = new AbortController()
    const reason = new Error('caller stopped budgeting')
    controller.abort(reason)
    const count = committed.length
    await expect(engine.compactIfNeeded(agent, 'pressure', controller.signal)).rejects.toBe(reason)
    expect(committed).toHaveLength(count)
  })

  it('summarizes below the host window threshold with an explicit text target and exact recovery citation', async () => {
    const { engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, toolHeadChars: 10000 })
    const result = await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(result).not.toBeNull()
    expect(adapter.summaries.length).toBeGreaterThan(0)
    const summaryInput = adapter.summaries[0]
    expect(JSON.stringify(summaryInput?.messages)).toContain('Target at most 512 summary text tokens')
    const checkpoint = committed.find(event => event.type === 'user/message' && event.surfaceOp !== 'append')
    expect(checkpoint?.type).toBe('user/message')
    expect(JSON.stringify(checkpoint?.data)).toContain('context_read')
    expect(committed.filter(event => event.type === 'compaction/start')).toHaveLength(committed.filter(event => event.type === 'compaction/end').length)
  })

  it('leaves the surface intact when auxiliary summarization fails', async () => {
    const { ctx, engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, toolHistoryTokens: 6000, protectedSteps: 0, minSavingsTokens: 128, toolHeadChars: 10000 })
    const listeners = streamListenerCount(ctx)
    adapter.failure = new Error('provider unreachable')
    // The deterministic first phase is independently durable; only the
    // unsuccessful summary must leave no replacement checkpoint behind.
    await expect(engine.compactIfNeeded(agent, 'pressure', signal())).rejects.toThrow()
    expect(committed.some(event => event.type === 'compaction/start')).toBe(true)
    expect(committed.some(event => event.type === 'compaction/end')).toBe(true)
    expect(committed.some(event => event.type === 'user/message')).toBe(false)
    expect(streamListenerCount(ctx)).toBe(listeners)
  })

  it('records exact source references for an inherited manual compaction', async () => {
    const { engine, agent, committed } = await harness({ toolHeadChars: 10000 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const result = await engine.compactNow(agent, signal())
    if (result === null) throw new Error('expected a useful manual reduction')
    const checkpoint = committed.find(event => event.type === 'user/message')
    const text = JSON.stringify(checkpoint?.data)
    expect(text).toContain(`\\"startSeq\\":${Math.min(...result.shadowedSeqs)}`)
    expect(text).toContain(`\\"endSeq\\":${Math.max(...result.shadowedSeqs)}`)
  })

  it('records a failed summary without a checkpoint when cancellation arrives during generation', async () => {
    const { ctx, engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, toolHeadChars: 10000 })
    const listeners = streamListenerCount(ctx)
    let start!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    adapter.onStart = start
    adapter.gate = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController()
    const operation = engine.compactIfNeeded(agent, 'pressure', controller.signal)
    await started
    controller.abort(new Error('cancel in-flight summary'))
    release()
    await expect(operation).rejects.toThrow()
    expect(committed.some(event => event.type === 'user/message')).toBe(false)
    expect(committed.some(event => event.type === 'compaction/end')).toBe(true)
    expect(streamListenerCount(ctx)).toBe(listeners)
  })


  it('retains complete small read and shell metadata beside shortened content', async () => {
    const metadata = { cwd: '/synthetic/project', path: 'src/build.ts', offset: 1, lines: 80 }
    const { engine, agent, committed } = await harness({}, true, 8, metadata)
    await engine.compactIfNeeded(agent, 'pressure', signal())
    const results = committed.filter(event => event.type === 'tool/result')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(event => JSON.stringify(event.data.meta) === JSON.stringify(metadata))).toBe(true)
  })

  it('protects oversized metadata without persisting it in a preview', async () => {
    const { engine, agent, committed } = await harness({ toolMetaMaxChars: 16 }, true, 8, { cwd: '/synthetic/project' })
    const count = committed.length
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(committed).toHaveLength(count)
  })

  it('defers a small eligible reduction until a full batch can amortize prefix invalidation', async () => {
    const { engine, agent, committed } = await harness({ toolHistoryTargetRatio: 0.25, protectedSteps: 3 }, true, 4)
    const count = committed.length
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(committed).toHaveLength(count)
  })

  it('logs the exact dynamic summary instruction independently of later configuration', async () => {
    const { engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, toolHeadChars: 10000, summaryTargetTokens: 256 })
    await engine.compactIfNeeded(agent, 'pressure', signal())
    const record = committed.map(pluginRecordOf).find(value => value?.type === 'plugin:dsh-context-kit/summary-policy')
    expect(record?.data).toMatchObject({ summaryTargetTokens: 256 })
    const data = record?.data
    if (typeof data !== 'object' || data === null || !('instruction' in data) || typeof data.instruction !== 'string') {
      throw new Error('summary-policy record lacks its reconstructable instruction')
    }
    const instruction = data.instruction
    expect(adapter.summaries.some(request => request.messages.some(message => message.content.some(block => block.type === 'text' && block.text === instruction)))).toBe(true)
    expect(instruction).toContain('Target at most 256')
  })


  it('preserves warm history when proactive tool pruning is disabled', async () => {
    const { engine, agent, committed, adapter } = await harness({ pruneToolResults: false })
    const count = committed.length
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(committed).toHaveLength(count)
    expect(adapter.summaries).toHaveLength(0)
  })

  it.each(['max', 'off'])('inherits explicit %s effort on the same route and logs it before generation', async effort => {
    const { ctx, engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, pruneToolResults: false })
    const original = agent.session.requestHeader()
    if (original === undefined) throw new Error('fixture lacks its request header')
    agent.session.append('request/header', { header: { ...original, config: { ...original.config, reasoningEffort: ReasoningEffortId(effort) } }, reason: 'change' })
    const header = agent.session.requestHeader()
    const listeners = streamListenerCount(ctx)
    adapter.onStart = () => {
      const record = committed.map(pluginRecordOf).find(value => value?.type === 'plugin:dsh-context-kit/summary-policy')
      expect(record?.data).toMatchObject({ reasoningEffort: effort })
    }
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: effort, maxTokens: 16384, purpose: 'compaction' })
    expect(agent.session.requestHeader()).toEqual(header)
    expect(streamListenerCount(ctx)).toBe(listeners)
  })

  it.each([
    { provider: 'summary-provider', model: 'deepseek-flash', policy: false },
    { provider: 'deepseek-official', model: 'summary-model', policy: false },
    { provider: 'deepseek-official', model: 'summary-model', policy: true },
  ])('uses $provider/$model own effort defaults with model policy=$policy', async ({ provider, model, policy }) => {
    const summary = { summarizationProvider: provider, summarizationModel: model }
    const { ctx, engine, agent, adapter, committed } = await harness({ maxContextTokens: 6000, pruneToolResults: false,
      ...policy ? { modelPolicies: [{ provider: 'deepseek-official', model: 'deepseek-flash', ...summary }] } : summary })
    if (provider !== 'deepseek-official') ctx.llm.registerAdapter([provider], adapter)
    adapter.reasoningEfforts[`${provider}/${model}`] = [ReasoningEffortId('off')]
    const original = agent.session.requestHeader()
    if (original === undefined) throw new Error('fixture lacks its request header')
    agent.session.append('request/header', { header: { ...original, config: { ...original.config, reasoningEffort: ReasoningEffortId('max') } }, reason: 'change' })
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]).toMatchObject({ provider, model, reasoningEffort: 'off', maxTokens: 16384 })
    const record = committed.map(pluginRecordOf).find(value => value?.type === 'plugin:dsh-context-kit/summary-policy')
    expect(record?.data).not.toHaveProperty('reasoningEffort')
  })

  it('limits temporary effort inheritance to the exact summary call while other streams dispatch', async () => {
    const { ctx, engine, agent, adapter } = await harness({ maxContextTokens: 6000, pruneToolResults: false })
    const original = agent.session.requestHeader()
    if (original === undefined) throw new Error('fixture lacks its request header')
    agent.session.append('request/header', { header: { ...original, config: { ...original.config, reasoningEffort: ReasoningEffortId('max') } }, reason: 'change' })
    const probes: { options: GenerateOptions; stream: AsyncIterable<StreamChunk> }[] = []
    let intercepted = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'llm/stream' || intercepted || args.length === 0) return
      const current = args[0] as GenerateOptions
      if (current.purpose !== 'compaction' || current.sessionId !== agent.id) return
      intercepted = true
      const unrelated = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Independent model request.' }] })
      for (const options of [
        { ...current, sessionId: SessionId('another-summary-session'), reasoningEffort: undefined },
        { ...current, purpose: undefined, reasoningEffort: undefined },
        { ...current, messages: [unrelated], reasoningEffort: undefined },
      ]) probes.push({ options, stream: ctx.llm.stream(options) })
    })
    const listeners = streamListenerCount(ctx)
    await engine.compactIfNeeded(agent, 'pressure', signal())
    expect(probes).toHaveLength(3)
    expect(probes.every(probe => probe.options.reasoningEffort === undefined)).toBe(true)
    expect(adapter.summaries[0]?.reasoningEffort).toBe('max')
    await Promise.all(probes.map(async probe => { for await (const _chunk of probe.stream) {} }))
    expect(adapter.summaries.slice(1).map(options => options.reasoningEffort)).toEqual(['high', 'high', 'high'])
    expect(streamListenerCount(ctx)).toBe(listeners)
  })


  it('inherits overflow recovery, durable summary settlement and the bounded retry budget', async () => {
    const { ctx, agent, adapter, committed } = await harness({ auto: true, pruneToolResults: false })
    const recover = () => agentEvents(ctx, agent).waterfall('agent/request-error', {
      turn: 2, step: 1, provider: 'deepseek-official', signal: signal(), retryPolicy: undefined,
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'provider confirmed context overflow' },
    }, () => Promise.resolve(undefined))
    await expect(recover()).resolves.toEqual({ kind: 'retry' })
    expect(adapter.summaries).toHaveLength(1)
    const transaction = committed.filter(event => ['compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type))
    expect(transaction.map(event => event.type)).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
    const summary = committed.find(event => event.type === 'compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('overflow recovery did not settle a durable summary')
    const text = JSON.stringify(summary.data.summary)
    expect(text).toContain(`\\"startSeq\\":${Math.min(...summary.data.shadowedSeqs)}`)
    expect(text).toContain(`\\"endSeq\\":${Math.max(...summary.data.shadowedSeqs)}`)
    expect(committed.some(event => event.type === 'compaction/prune')).toBe(false)
    await expect(recover()).resolves.toBeUndefined()
    expect(adapter.summaries).toHaveLength(1)
  })

  it('inherits destination-window safety while applying the absolute soft budget at the next pressure check', async () => {
    const small = await harness({ auto: true, pruneToolResults: false, maxContextTokens: 6000 })
    small.adapter.contextWindows['smaller-window'] = 12000
    const originalHeader = small.agent.session.requestHeader()
    const selected = { provider: 'deepseek-official', model: 'smaller-window', maxTokens: 8192 }
    await expect(agentEvents(small.ctx, small.agent).waterfall('agent/request', {
      turn: 2, step: 1, signal: signal(),
    }, () => Promise.resolve(selected))).resolves.toEqual(selected)
    expect(small.adapter.summaries).toHaveLength(1)
    expect(small.adapter.summaries[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'compaction' })
    expect(small.ctx.tokenMeter.measure(small.agent.session, { config: selected }).totalTokens).toBeLessThan(12000 - 8192)
    expect(small.agent.session.requestHeader()).toEqual(originalHeader)

    const roomy = await harness({ auto: true, pruneToolResults: false, maxContextTokens: 6000 })
    const before = roomy.ctx.tokenMeter.measure(roomy.agent.session).totalTokens
    expect(before).toBeGreaterThan(6000)
    const destination = { provider: 'deepseek-official', model: 'roomy-window', maxTokens: 8192 }
    await expect(agentEvents(roomy.ctx, roomy.agent).waterfall('agent/request', {
      turn: 2, step: 1, signal: signal(),
    }, () => Promise.resolve(destination))).resolves.toEqual(destination)
    // The inherited switch path checks the destination window; its first
    // request can remain above this provider's independent absolute budget.
    expect(roomy.adapter.summaries).toHaveLength(0)
    expect(roomy.ctx.tokenMeter.measure(roomy.agent.session).totalTokens).toBe(before)
    roomy.agent.session.append('request/header', { header: { config: destination }, reason: 'change' })
    await roomy.engine.compactIfNeeded(roomy.agent, 'pressure', signal())
    expect(roomy.adapter.summaries.length).toBeGreaterThan(0)
    expect(roomy.committed.some(event => event.type === 'compaction/summary')).toBe(true)
  })

})
