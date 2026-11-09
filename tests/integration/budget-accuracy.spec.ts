/** Exact-fact recovery through the real loop after a deliberately lossy summary. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BudgetedCompactionEngine from '../../src/budgeted/index.ts'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as ContextRecall from '../../src/recall/index.ts'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { budgetHistory, HISTORY_FACTS } from './budget-history.ts'

interface RecallPage {
  records: { seq: number; text: string; isError?: boolean }[]
}

class RecoveryAdapter extends LlmAdapter {
  private phase = 0
  private readonly recovered: string[] = []
  readonly conversationRequests: GenerateOptions[] = []
  summaryCalls = 0

  constructor(private readonly allEvidence = false) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_048_576 }, defaultMaxTokens: 8192 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let text: string | undefined
    let call: { name: string; arguments: string } | undefined
    if (options.purpose === 'compaction') {
      this.summaryCalls += 1
      text = 'Build inspection is ongoing. Exact historical release metadata must be recovered from original records.'
    } else {
      this.conversationRequests.push(options)
      const queries = this.allEvidence ? ['artifact-tag', 'retry-error', 'Never modify'] : ['artifact-tag']
      if (this.phase === 0) {
        expect(JSON.stringify(options.messages)).not.toContain(HISTORY_FACTS.artifactTag)
        call = { name: 'context_search', arguments: JSON.stringify({ query: queries[0] }) }
      } else {
        const result = options.messages.findLast(message => message.role === 'tool')
        const rendered = result?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        if (rendered === undefined) throw new Error('missing model-visible recall result')
        const page = JSON.parse(rendered) as RecallPage
        if (this.phase % 2 === 1) {
          const query = queries[Math.floor(this.phase / 2)]
          if (query === undefined) throw new Error('missing search query')
          const hit = page.records.find(record => record.text.includes(query))
          if (hit === undefined) throw new Error('search did not recover the old literal')
          call = { name: 'context_read', arguments: JSON.stringify({ startSeq: hit.seq }) }
        } else {
          const original = page.records.map(record => record.text).join('')
          if (this.allEvidence && this.phase === 4) expect(page.records.some(record => record.isError === true)).toBe(true)
          this.recovered.push(original)
          const query = queries[this.phase / 2]
          if (query !== undefined) call = { name: 'context_search', arguments: JSON.stringify({ query }) }
          else {
            const evidence = this.recovered.join('\n')
            const artifactTag = /artifact-tag=([^\s;]+)/u.exec(evidence)?.[1]
            if (artifactTag === undefined) throw new Error('read did not return the original artifact value')
            if (this.allEvidence) {
              const retryLimit = /retry-limit=(\d+)/u.exec(evidence)?.[1]
              const retryError = /retry-error=([^\s;]+)/u.exec(evidence)?.[1]
              const protectedFile = /Never modify ([^\s.]+\.[^\s.]+)/u.exec(evidence)?.[1]
              if (retryLimit === undefined || retryError === undefined || protectedFile === undefined) throw new Error('original user or failure evidence is missing')
              text = JSON.stringify({ artifactTag, retryLimit: Number(retryLimit), retryError, protectedFile })
            } else text = artifactTag
          }
        }
      }
      this.phase += 1
    }
    if (call !== undefined) {
      const block = { type: 'tool-call' as const, id: ToolCallId(`recall-${this.phase}`), ...call }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      if (text === undefined) throw new Error('fixture has no response')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

describe('budgeted exact history recovery', () => {
  it('recovers an old result middle after pruning and summary both hide the fact', async () => {
    const ctx = new Context()
    const adapter = new RecoveryAdapter()
    const seed = budgetHistory()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      await ctx.plugin(ToolResultPruner)
      await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
      await ctx.plugin(ContextRecall)
      ctx.llm.registerAdapter(['deepseek-official'], adapter)
      ctx.tools.register(defineTool({
        name: 'inspect_build', description: 'Old build records cannot be regenerated.',
        parameters: { index: { type: 'integer', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => { throw new Error('the model must recover the historical record instead') },
      }))
      await ctx.plugin(BudgetedCompactionEngine, {
        pruneToolResults: true, maxContextTokens: 6000, toolHistoryTokens: 2400, retainTokens: 1024,
        protectedSteps: 2, minSavingsTokens: 128, summaryTargetTokens: 512,
        maxTokens: 8192, headroomTokens: 0,
      })
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('budget-exact-recovery'), seed,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192 },
      })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recover the artifact-tag from the original build record. Do not regenerate the old result.' }] }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(adapter.summaryCalls).toBeGreaterThan(0)
      expect(events.some(event => event.type === 'compaction/prune')).toBe(true)
      expect(adapter.conversationRequests).toHaveLength(3)
      const newCalls = events.slice(seed.length).flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
      expect(newCalls).toEqual(['context_search', 'context_read'])
      const final = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
      expect(final?.content).toEqual([{ type: 'text', text: HISTORY_FACTS.artifactTag }])
      expect(events.slice(0, seed.length)).toEqual(seed)
      const recalled = events.slice(seed.length).filter(event => event.type === 'tool/result')
      expect(recalled.every(event => !event.data.message.isError)).toBe(true)
      const originalRead = recalled.find(event => event.data.message.toolCallId === 'recall-2' && event.surfaceOp === 'append')
      expect(JSON.stringify(originalRead?.data.message.content)).toContain(HISTORY_FACTS.artifactTag)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retrieves the original user prohibition and error retry facts after a lossy summary', async () => {
    const ctx = new Context()
    const adapter = new RecoveryAdapter(true)
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      await ctx.plugin(ToolResultPruner)
      await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
      await ctx.plugin(ContextRecall)
      ctx.llm.registerAdapter(['deepseek-official'], adapter)
      await ctx.plugin(BudgetedCompactionEngine, {
        pruneToolResults: true, maxContextTokens: 6000, toolHistoryTokens: 2400, retainTokens: 1024,
        protectedSteps: 2, minSavingsTokens: 128, summaryTargetTokens: 512,
        maxTokens: 8192, headroomTokens: 0,
      })
      const seed = budgetHistory()
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('budget-evidence-recovery'), seed,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192 },
      })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recover the original artifact tag, retry failure and limit, and my original prohibition. Search and read the original records.' }] }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(adapter.summaryCalls).toBeGreaterThan(0)
      expect(adapter.conversationRequests).toHaveLength(7)
      expect(events.slice(seed.length).flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])).toEqual([
        'context_search', 'context_read', 'context_search', 'context_read', 'context_search', 'context_read',
      ])
      const final = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
      const answer = final?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      expect(JSON.parse(answer ?? 'null')).toEqual(HISTORY_FACTS)
      expect(events.slice(0, seed.length)).toEqual(seed)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
