/** Real-provider fidelity probes over the same independently seeded coding history. */
import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import BudgetedCompactionEngine from '../../src/budgeted/index.ts'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as ContextRecall from '../../src/recall/index.ts'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { createUserMessage, ReasoningEffortId, type TokenUsage, type FinishReason } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { budgetHistory, HISTORY_FACTS } from './budget-history.ts'

interface CallUsage {
  readonly purpose: string
  readonly usage?: TokenUsage
  readonly finish?: FinishReason
}

async function probe(mode: 'baseline' | 'budgeted'): Promise<{ text: string; calls: CallUsage[]; prunes: number; summaries: number; wallMs: number }> {
  const ctx = new Context()
  const calls: CallUsage[] = []
  try {
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { personaPrefix: 'Follow the user exactly. Use the history tools to recover original records. Return the requested JSON object without markdown.' },
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ToolResultPruner)
    await ctx.plugin(DeepSeek, { reasoningEffort: 'off', maxTokens: 8192 })
    if (mode === 'budgeted') {
      await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
      await ctx.plugin(ContextRecall)
    }
    ctx.tools.register(defineTool({
      name: 'inspect_build', description: 'Only new build results are available; old artifact tags and retry facts cannot be regenerated.',
      parameters: { index: { type: 'integer', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('No archived build details are available from this tool. Search the conversation history instead.'),
    }))
    ctx.on('llm/stream', async function* (options, next) {
      let usage: TokenUsage | undefined
      let finish: FinishReason | undefined
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
      calls.push({ purpose: options.purpose ?? 'conversation', ...(usage === undefined ? {} : { usage }), ...(finish === undefined ? {} : { finish }) })
    })
    if (mode === 'baseline') await ctx.plugin(BasicCompactionEngine)
    else await ctx.plugin(BudgetedCompactionEngine, {
      pruneToolResults: true, maxContextTokens: 6000, toolHistoryTokens: 2400, retainTokens: 1024,
      protectedSteps: 2, minSavingsTokens: 128, summaryTargetTokens: 512,
      maxTokens: 8192, headroomTokens: 0,
    })
    const seed = budgetHistory()
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(`budget-fidelity-${mode}`), seed,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192, reasoningEffort: ReasoningEffortId('off') },
    })
    const started = performance.now()
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Recover the ORIGINAL records, not a guessed value or a rewritten summary. If a needed exact detail is absent from the active context, use the available context history tools to locate and read the original record before answering. Also recover the file path I originally prohibited changing. Return exactly one JSON object with keys artifactTag (string), retryLimit (number), retryError (string), protectedFile (string). Do not call inspect_build: it cannot reproduce the historical facts.' }],
    }))
    await agent.whenIdle()
    const closure = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(closure?.data.reason, JSON.stringify(calls)).toMatchObject({ kind: 'completed' })
    const last = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
    const text = last?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
    const events = agent.session.snapshotEvents()
    if (mode === 'budgeted') {
      const currentCalls = events.slice(seed.length).filter(event => event.type === 'tool/call')
      expect(currentCalls.some(event => event.data.name === 'context_search')).toBe(true)
      expect(currentCalls.some(event => event.data.name === 'context_read')).toBe(true)
    }
    return {
      text, calls, wallMs: performance.now() - started,
      prunes: events.filter(event => event.type === 'compaction/prune').length,
      summaries: events.filter(event => event.type === 'compaction/summary').length,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('budgeted context fidelity (real API)', () => {
  it('recovers exact original values, a user restriction, and retry evidence at equal task input', async () => {
    const results = []
    for (const mode of ['baseline', 'budgeted'] as const) {
      const result = await probe(mode)
      await mkdir(new URL('../../.artifacts/fidelity/', import.meta.url), { recursive: true })
      await writeFile(new URL(`../../.artifacts/fidelity/${mode}.json`, import.meta.url), JSON.stringify({ mode, calls: result.calls, wallMs: result.wallMs, prunes: result.prunes, summaries: result.summaries }, null, 2) + '\n')
      expect(JSON.parse(result.text)).toEqual(HISTORY_FACTS)
      expect(result.calls.length).toBeGreaterThanOrEqual(1)
      expect(result.calls.every(call => call.usage !== undefined)).toBe(true)
      if (mode === 'budgeted') {
        expect(result.prunes).toBeGreaterThan(0)
        expect(result.summaries).toBeGreaterThan(0)
      }
      results.push({ mode, calls: result.calls, prunes: result.prunes, summaries: result.summaries, wallMs: result.wallMs })
    }
    // Provider usage, including auxiliary summaries and recall requests, is
    // retained as run evidence; this probe makes no universal quality claim.
    console.info('context-budget-fidelity', JSON.stringify(results))
  })
})
