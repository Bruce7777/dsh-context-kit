/** Public-API-only budget compaction provider for DeepSeek Harness 0.2.2. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ReasoningEffortId, TokenUsage, ToolSchema, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:dsh-context-kit/summary-policy': {
      instruction: string
      summaryTargetTokens: number
      startSeq: SessionSeq | null
      endSeq: SessionSeq | null
      /** Main-request effort explicitly inherited by a same-route summary call. */
      reasoningEffort?: ReasoningEffortId
    }
  }
}
import { resolveBudgetConfig } from './config.js'
import { createBudgetSurfaceProjection } from './projection.js'
import type { BudgetSurfaceState } from './projection.js'
import type { BudgetedCompactionConfig, ResolvedBudgetedConfig } from './types.js'

export type { BudgetedCompactionConfig, ResolvedBudgetedConfig } from './types.js'

interface SummaryInput { readonly tools?: readonly ToolSchema[]; readonly messages: readonly Message[] }
type SummaryResult = {
  summary: ContentBlock[]; provider: string; model: string; maxTokens?: number; usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never })

/** Optional provider sharing the host's durable summary transaction and overflow recovery. */
export class BudgetedCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'sessionProjections', 'tools']
  static override Config: z<BudgetedCompactionConfig> = z.intersect([
    BasicCompactionEngine.Config,
    z.object({
      pruneToolResults: z.boolean(),
      maxContextTokens: z.number().step(1).min(1), toolHistoryTokens: z.number().step(1).min(1),
      toolHistoryTargetRatio: z.number(), protectedSteps: z.number().step(1).min(0),
      minSavingsTokens: z.number().step(1).min(1), toolHeadChars: z.number().step(1).min(0),
      toolTailChars: z.number().step(1).min(0), toolMetaMaxChars: z.number().step(1).min(0), summaryTargetTokens: z.number().step(1).min(1),
    }),
  ])

  /** Validated token budgets, independent of the model's maximum window. */
  readonly budget: ResolvedBudgetedConfig
  private readonly meter: Context['tokenMeter']
  private readonly modelRuntime: Context['llm']
  private readonly toolRegistry: Context['tools']
  private readonly projectionReady: Promise<ProjectionHandle<BudgetSurfaceState>>
  private readonly selectedRanges = new WeakMap<Session, readonly SessionSeq[]>()

  /**
   * @param ctx - host context with LLM, meter, Session and tool services.
   * @param config - deployment budgets plus ordinary Basic model settings.
   */
  constructor(ctx: Context, config: BudgetedCompactionConfig = {}) {
    const budget = resolveBudgetConfig(config)
    super(ctx, budget.basic)
    this.budget = budget
    this.meter = ctx.tokenMeter
    this.modelRuntime = ctx.llm
    this.toolRegistry = ctx.tools
    const estimateMessage = this.meter.estimateMessage.bind(this.meter)
    this.projectionReady = ctx.sessionProjections.register(createBudgetSurfaceProjection({
      enabled: budget.pruneToolResults, headChars: budget.toolHeadChars, tailChars: budget.toolTailChars, metaMaxChars: budget.toolMetaMaxChars,
      estimateMessage,
    }))
  }

  protected async [Service.init](): Promise<void> { await this.projectionReady }

  /**
   * Consider independent tool-history pressure before ordinary window pressure.
   * @param agent - owner of the current durable conversation.
   * @param trigger - ordinary pressure or provider-confirmed overflow.
   * @param signal - operation cancellation forwarded to model and summary calls.
   * @returns the last committed summary, or null when no summary is needed.
   */
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal)
    const projection = await this.projectionReady
    const state = projection.stateOf(agent.session)
    if (state.activeCompaction) return null
    if (this.budget.pruneToolResults && state.toolTokens > this.budget.toolHistoryTokens) this.pruneHistory(agent, state, signal)
    const header = agent.session.requestHeader()
    if (header === undefined) return null
    const target = header.config
    if (target.provider === '' || target.model === '') return null
    const info = await this.modelRuntime.resolveModelInfo(target.provider, target.model, signal)
    signal.throwIfAborted()
    if (info.context === undefined) return super.compactIfNeeded(agent, trigger, signal)
    const override = this.config.modelPolicies.find(policy => policy.provider === target.provider && policy.model === target.model)
    const output = header.config.maxTokens ?? info.defaultMaxTokens ?? 0
    const messageBudget = info.context.contextWindow - output
    const threshold = Math.floor(Math.min(this.budget.maxContextTokens,
      info.context.contextWindow * (override?.thresholdRatio ?? this.config.thresholdRatio),
      messageBudget - (override?.headroomTokens ?? this.config.headroomTokens)))
    if (threshold <= 0) throw new LlmError('Context window has no input budget after output and compaction reservations; reduce maxTokens or headroomTokens.', 'CONTEXT_BUDGET_CONFIG')
    const baseRetention = override?.retainTokens ?? (override?.retainRatio === undefined
      ? this.config.retainTokens ?? Math.floor(messageBudget * (this.config.retainRatio ?? 0))
      : Math.floor(messageBudget * override.retainRatio))
    let result: CompactionResult | null = null
    const retries = override?.compactionRetries ?? this.config.compactionRetries
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const measurement = this.meter.measure(agent.session)
      if (measurement.totalTokens < threshold) return result
      const current = projection.stateOf(agent.session)
      const firstProtected = current.nodes.findIndex(node => node.stepOrdinal > current.completedSteps - this.budget.protectedSteps)
      const protectedTokens = firstProtected < 0 ? 0 : measurement.nodes.slice(firstProtected).reduce((sum, node) => sum + node.tokens, 0)
      const range = this.selectRange(agent, current, measurement, Math.max(baseRetention, protectedTokens))
      if (range === null) return result
      result = await this.compactRegion(range.start, range.end, agent, signal)
    }
    return result
  }

  /**
   * Share the host's complete durable transaction while remembering its source citations.
   * @param start - first selected surface sequence.
   * @param end - last selected surface sequence in surface order.
   * @param agent - conversation owner.
   * @param signal - optional cancellation forwarded unchanged.
   * @returns the committed summary and source metadata.
   */
  override async compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal): Promise<CompactionResult> {
    const nodes = agent.session.surface.nodes
    const from = nodes.indexOf(start)
    const to = nodes.indexOf(end)
    if (this.selectedRanges.has(agent.session)) throw new LlmError('A context compaction is already running for this session.', 'CONTEXT_COMPACTION_BUSY')
    this.selectedRanges.set(agent.session, nodes.slice(from, to + 1))
    try { return await super.compactRegion(start, end, agent, signal) }
    finally { this.selectedRanges.delete(agent.session) }
  }

  protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    this.assertRecallAvailable(agent)
    const projection = await this.projectionReady
    const nodes = projection.stateOf(agent.session).nodes
    const messageIds = new Set(input.messages.map(message => message.id))
    const seqs = this.selectedRanges.get(agent.session)
      ?? nodes.filter((node, index) => !(index === 0 && node.system)
        && node.messageId !== null && messageIds.has(node.messageId)).map(node => node.seq)
    const instruction = `Target at most ${this.budget.summaryTargetTokens} summary text tokens. Preserve explicit user requirements, corrections, unresolved failures, pending work and exact identifiers needed to continue; omit replaceable bulk output.`
    const hint = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: instruction }] })
    const previous = agent.session.requestHeader()?.config
    const first = seqs.reduce<SessionSeq | null>((value, seq) => value === null || seq < value ? seq : value, null)
    const last = seqs.reduce<SessionSeq | null>((value, seq) => value === null || seq > value ? seq : value, null)
    signal?.throwIfAborted()
    const dispose = this.ctx.on('llm/stream', (options, next) => {
      if (options.purpose !== 'compaction' || options.sessionId !== agent.session.id
        || !options.messages.includes(hint)) return next()
      dispose()
      signal?.throwIfAborted()
      const reasoningEffort = previous?.provider === options.provider && previous.model === options.model
        ? previous.reasoningEffort : undefined
      if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort
      appendPluginRecord(agent.session, 'plugin:dsh-context-kit/summary-policy', {
        instruction, summaryTargetTokens: this.budget.summaryTargetTokens, startSeq: first, endSeq: last,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      })
      return next()
    }, { prepend: true })
    let result: SummaryResult
    try { result = await super.summarize({ ...input, messages: [...input.messages, hint] }, agent, signal) }
    finally { dispose() }
    signal?.throwIfAborted()
    if (first === null || last === null) return result
    return { ...result, summary: [...result.summary, { type: 'text', text:
      `Original conversation: context_read({"startSeq":${first},"endSeq":${last}}). Search omitted facts with context_search before guessing.` }] }
  }

  private selectRange(agent: Agent, state: BudgetSurfaceState, measurement: TokenMeasurement, retainTokens: number): { start: SessionSeq; end: SessionSeq } | null {
    const first = state.nodes[0]?.system === true ? 1 : 0
    let keep = measurement.nodes.length
    let tokens = 0
    while (keep > first) {
      const node = measurement.nodes[--keep]
      if (node !== undefined) tokens += node.tokens
      if (tokens >= retainTokens) break
    }
    while (keep > first) {
      const seq = measurement.nodes[keep]?.seq
      if (seq !== undefined && toolPairingBalancedBefore(agent.session, seq)) break
      keep -= 1
    }
    const start = measurement.nodes[first]?.seq
    const end = measurement.nodes[keep - 1]?.seq
    if (keep <= first || start === undefined || end === undefined) return null
    const selectedTokens = measurement.nodes.slice(first, keep).reduce((sum, node) => sum + node.tokens, 0)
    return selectedTokens >= this.budget.summaryTargetTokens + this.budget.minSavingsTokens ? { start, end } : null
  }

  private pruneHistory(agent: Agent, state: BudgetSurfaceState, signal: AbortSignal): void {
    this.assertRecallAvailable(agent)
    const target = state.toolTokens - Math.floor(this.budget.toolHistoryTokens * this.budget.toolHistoryTargetRatio)
    const candidates: BudgetSurfaceState['nodes'] = []
    let savings = 0
    for (const node of state.nodes) {
      if (node.preview === null || node.stepOrdinal > state.completedSteps - this.budget.protectedSteps) continue
      candidates.push(node)
      savings += node.preview.originalTokens - node.preview.previewTokens
      if (savings >= target) break
    }
    const minimumBatchSavings = Math.max(this.budget.minSavingsTokens,
      Math.ceil(this.budget.toolHistoryTokens * (1 - this.budget.toolHistoryTargetRatio)))
    if (savings < minimumBatchSavings) return
    for (const node of candidates) {
      signal.throwIfAborted()
      const preview = node.preview
      if (preview === null) continue
      if (!agent.session.surface.nodes.includes(node.seq)) throw new LlmError('Tool history changed during pruning; stop this batch and retry.', 'CONTEXT_SURFACE_CHANGED')
      const message: ToolResultMessage = { id: preview.messageId, role: 'tool', source: { kind: 'tool', callId: preview.callId },
        toolCallId: preview.callId, content: [{ type: 'text', text: preview.text }],
        ...preview.hasErrorFlag ? { isError: false } : {} }
      agent.session.append('compaction/prune', { shadowedRange: { start: node.seq, end: node.seq },
        shadowedSeqs: [node.seq], shadowedTokenCount: preview.originalTokens })
      agent.session.append('tool/result', { turn: preview.turn, step: preview.step, message,
        ...preview.meta === undefined ? {} : { meta: preview.meta } }, {
        surfaceOp: { op: 'replace', startSeq: node.seq, endSeq: node.seq }, sourceEventSeqs: [node.seq],
      })
    }
  }

  private assertRecallAvailable(agent: Agent): void {
    if (this.toolRegistry.get('context_read', agent) === undefined || this.toolRegistry.get('context_search', agent) === undefined) {
      throw new LlmError('Budgeted compaction requires visible context_read and context_search tools; enable the context recall plugin for this agent.', 'CONTEXT_RECALL_UNAVAILABLE')
    }
  }
}

export default BudgetedCompactionEngine
