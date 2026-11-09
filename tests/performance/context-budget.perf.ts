/**
 * Built-runtime diagnostic for synthetic tool-heavy tasks. Compile this driver
 * with tsdown, then run each mode in a fresh `node --expose-gc` process. Model
 * calls are scripted; token counts are heuristic rather than provider billing.
 */
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const repository = new URL('../../', import.meta.url)
const testkitRequire = createRequire(new URL('package.json', repository))
const basicRequire = testkitRequire
const cordis: typeof import('@deepseek-ai/cordis') = await import(testkitRequire.resolve('@deepseek-ai/cordis'))
const llm: typeof import('@deepseek-ai/dsh-llm') = await import(testkitRequire.resolve('@deepseek-ai/dsh-llm'))
const session: typeof import('@deepseek-ai/dsh-session') = await import(testkitRequire.resolve('@deepseek-ai/dsh-session'))
const loop: typeof import('@deepseek-ai/dsh-agent-loop') = await import(testkitRequire.resolve('@deepseek-ai/dsh-agent-loop'))
const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = await import(testkitRequire.resolve('@deepseek-ai/dsh-agent-loop-testkit'))
const tools: typeof import('@deepseek-ai/dsh-tools') = await import(testkitRequire.resolve('@deepseek-ai/dsh-tools'))
const basic: typeof import('@deepseek-ai/dsh-compaction-basic') = await import(testkitRequire.resolve('@deepseek-ai/dsh-compaction-basic'))
const tokenMeter: typeof import('@deepseek-ai/dsh-token-meter') = await import(basicRequire.resolve('@deepseek-ai/dsh-token-meter'))
const pruner: typeof import('@deepseek-ai/dsh-compaction-tool-result-pruner') = await import(basicRequire.resolve('@deepseek-ai/dsh-compaction-tool-result-pruner'))

const mode = process.argv[2] ?? 'baseline'
const steps = Number(process.argv[3] ?? 96)
const accountPrefix = process.argv.includes('--prefix')
const pruningEnabled = process.argv.includes('--prune')
const toolKind = process.argv.find(arg => arg.startsWith('--tool='))?.split('=')[1] ?? 'synthetic'
if (!['synthetic', 'read', 'bash'].includes(toolKind)) throw new Error('tool must be synthetic, read, or bash')
const ratioArg = process.argv.find(arg => arg.startsWith('--target-ratio='))?.split('=')[1]
const savingsArg = process.argv.find(arg => arg.startsWith('--min-savings='))?.split('=')[1]
const targetRatio = ratioArg === undefined ? 0.75 : Number(ratioArg)
const minSavings = savingsArg === undefined ? 1024 : Number(savingsArg)
if (!(targetRatio > 0 && targetRatio < 1) || !Number.isSafeInteger(minSavings) || minSavings < 1) throw new Error('invalid diagnostic policy')
if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1024) throw new Error('steps must be 1..1024')
if (mode !== 'baseline' && mode !== 'baseline-plain' && mode !== 'budgeted') throw new Error('mode must be baseline-plain, baseline, or budgeted')

const ctx = new cordis.Context()
let agent: Agent | undefined
let fixtureRoot: string | undefined
let meter: InstanceType<typeof tokenMeter.default>
const metrics = { conversationRequests: 0, summaryRequests: 0, inputHeuristicTokens: 0, outputHeuristicTokens: 0, maxInputHeuristicTokens: 0, prefixTotalCharacters: 0, prefixReusedCharacters: 0 }
const facts = 'release-marker=azure-falcon-42; preserve config/production.yml; retry-limit=7'
const summary = `Current task: inspect the synthetic build records and preserve all user constraints. ${facts}. Recent validation is unfinished; continue the requested work.`

function output(index: number): string {
  const heading = `record-${index}: build ${index % 3 === 0 ? 'failed: E_SYNTHETIC_RETRY' : 'passed'}\n`
  const body = index % 8 === 0
    ? 'compiler detail: synthetic module export and call-site diagnostic\n'.repeat(160)
    : `package-${index % 7}: source path src/component-${index}.ts validated\n`.repeat(48 + index % 11)
  return heading + (index === 1 ? `${facts}\n` : '') + body + `\nend-record-${index}`
}

class WorkloadAdapter extends llm.LlmAdapter {
  private completed = 0
  private previousRequest = ''

  clearPrefix(): void { this.previousRequest = '' }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (accountPrefix) {
      const wire = JSON.stringify({ tools: options.tools, system: options.system, messages: options.messages.map(message => ({
        role: message.role, content: message.content, ...message.role === 'tool' ? { toolCallId: message.toolCallId, isError: message.isError } : {},
      })) })
      let reused = 0
      while (reused < this.previousRequest.length && reused < wire.length && this.previousRequest.charCodeAt(reused) === wire.charCodeAt(reused)) reused += 1
      metrics.prefixTotalCharacters += wire.length
      metrics.prefixReusedCharacters += reused
      this.previousRequest = wire
    }
    const input = options.messages.reduce((sum, message) => sum + meter.estimateMessage(message.id === undefined
      ? llm.createUserMessage({ source: { kind: 'user' }, content: message.content }) : message), 0)
      + (options.tools?.length ? meter.estimateMessage(llm.createSystemMessage(JSON.stringify(options.tools))) : 0)
      + (options.system ? meter.estimateMessage(llm.createSystemMessage(options.system)) : 0)
    if (!Number.isFinite(input)) throw new Error('non-finite request token estimate')
    metrics.inputHeuristicTokens += input
    metrics.maxInputHeuristicTokens = Math.max(metrics.maxInputHeuristicTokens, input)
    if (options.purpose === 'compaction') {
      metrics.summaryRequests += 1
      metrics.outputHeuristicTokens += meter.estimateMessage(llm.createMessage({ role: 'assistant', content: [{ type: 'text', text: summary }], source: { kind: 'model', provider: 'synthetic', model: 'fixture' } }))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    metrics.conversationRequests += 1
    if (this.completed < steps) {
      const current = this.completed++
      const name = toolKind === 'synthetic' ? 'inspect_build' : toolKind
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const path = fixtureRoot === undefined ? '' : join(fixtureRoot, `record-${current}.txt`)
      const args = toolKind === 'read' ? { file_path: path }
        : toolKind === 'bash' ? { command: `${quote(process.execPath)} -e ${quote('process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))')} ${quote(path)}`, description: `Read synthetic build record ${current}` }
        : { index: current }
      const block = { type: 'tool-call' as const, id: llm.ToolCallId(`work-${current}`), name, arguments: JSON.stringify(args) }
      metrics.outputHeuristicTokens += meter.estimateMessage(llm.createMessage({ role: 'assistant', content: [block], source: { kind: 'model', provider: 'synthetic', model: 'fixture' } }))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const answer = 'Synthetic build inspection finished.'
    metrics.outputHeuristicTokens += meter.estimateMessage(llm.createMessage({ role: 'assistant', content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'synthetic', model: 'fixture' } }))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

try {
  if (toolKind !== 'synthetic') {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-context-files-'))
    await Promise.all(Array.from({ length: steps }, (_, index) => writeFile(join(fixtureRoot!, `record-${index}.txt`), output(index))))
  }
  await testkit.mountAgentLoopTestDependencies(ctx, { workingDirectory: toolKind !== 'synthetic' })
  await ctx.plugin(loop.default, { agents: [] })
  await ctx.plugin(tokenMeter.default)
  meter = ctx.tokenMeter
  await ctx.plugin(pruner.default)
  const adapter = new WorkloadAdapter()
  ctx.llm.registerAdapter(['synthetic'], adapter)
  if (toolKind === 'read') {
    const fsTools: typeof import('@deepseek-ai/dsh-tool-fs') = await import(testkitRequire.resolve('@deepseek-ai/dsh-tool-fs'))
    await ctx.plugin(fsTools, { applyPatch: false })
  } else if (toolKind === 'bash') {
    const subprocess: typeof import('@deepseek-ai/dsh-subprocess-local') = await import(testkitRequire.resolve('@deepseek-ai/dsh-subprocess-local'))
    const bash: typeof import('@deepseek-ai/dsh-bash-local') = await import(testkitRequire.resolve('@deepseek-ai/dsh-bash-local'))
    const shellEnv: typeof import('@deepseek-ai/dsh-shell-env') = await import(testkitRequire.resolve('@deepseek-ai/dsh-shell-env'))
    const bashTool: typeof import('@deepseek-ai/dsh-tool-bash') = await import(testkitRequire.resolve('@deepseek-ai/dsh-tool-bash'))
    await ctx.plugin(subprocess.default)
    await ctx.plugin(bash.default)
    await ctx.plugin(shellEnv)
    await ctx.plugin(bashTool, { enableRunInBackground: false })
  }
  if (toolKind === 'synthetic') ctx.tools.register(tools.defineTool({
    name: 'inspect_build', description: 'Inspect one fixed synthetic build result.',
    parameters: { index: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(output(args.index)),
  }))
  if (mode !== 'baseline-plain') {
    const recall: typeof import('../../src/recall/index.ts') = await import(import.meta.resolve('dsh-context-kit/recall'))
    const query: typeof import('@deepseek-ai/dsh-session-query-sqlite') = await import(testkitRequire.resolve('@deepseek-ai/dsh-session-query-sqlite'))
    await ctx.plugin(query.default, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(recall)
  }
  if (mode === 'baseline' || mode === 'baseline-plain') await ctx.plugin(basic.default)
  else {
    const candidate: typeof import('../../src/budgeted/index.ts') = await import(import.meta.resolve('dsh-context-kit/budgeted'))
    await ctx.plugin(candidate.default, { pruneToolResults: pruningEnabled, toolHistoryTargetRatio: targetRatio, minSavingsTokens: minSavings })
  }
  if (toolKind !== 'synthetic') ctx.on('agent/created', ({ agent: created }) => {
    created.ctx.tools.restrict({ allow: [toolKind, ...mode === 'baseline-plain' ? [] : ['context_read', 'context_search']] })
  })
  agent = await ctx.agentLoop.create(session.SessionId('context-budget-performance'), { provider: 'synthetic', model: 'fixture' }, fixtureRoot === undefined ? {} : { cwd: fixtureRoot })
  globalThis.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Inspect ${steps} synthetic build results in order. Preserve config/production.yml. Remember the exact release-marker and retry-limit from the records.` }] }))
  await idle
  const wallMs = performance.now() - start
  adapter.clearPrefix()
  const cpu = process.cpuUsage(cpuBefore)
  globalThis.gc?.()
  const events = agent.session.snapshotEvents()
  const results = events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result' && event.surfaceOp === 'append')
  const finals = agent.session.deriveMessages()
  if (metrics.conversationRequests !== steps + 1 || results.length !== steps || results.some(event => event.type === 'tool/result' && event.data.message.isError) || !JSON.stringify(finals.at(-1)).includes('Synthetic build inspection finished.')) {
    throw new Error('synthetic task failed to finish with every original tool result retained')
  }
  const usage = process.memoryUsage()
  const originals = new Map(results.map(event => [event.data.message.toolCallId, event.data.meta]))
  const replacements = events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result' && event.surfaceOp !== 'append')
  if (replacements.some(event => JSON.stringify(event.data.meta) !== JSON.stringify(originals.get(event.data.message.toolCallId)))) {
    throw new Error('replacement changed original tool metadata')
  }
  const metadataLengths = results.flatMap(event => event.data.meta === undefined ? [] : [JSON.stringify(event.data.meta).length])
  process.stdout.write(JSON.stringify({ mode, steps, prefixAccounting: accountPrefix, pruningEnabled, toolKind, targetRatio, minSavings, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, retainedHeapDelta: usage.heapUsed - heapBefore, heapUsed: usage.heapUsed, rss: usage.rss, peakRss: process.resourceUsage().maxRSS * 1024, surfaceNodes: agent.session.surface.nodes.length, logEvents: events.length, pruneEvents: events.filter(event => event.type === 'compaction/prune').length, metadataResults: metadataLengths.length, metadataReplacements: replacements.filter(event => event.data.meta !== undefined).length, metadataAboveDefaultCap: metadataLengths.filter(length => length > 4096).length, metadataMinCharacters: metadataLengths.length === 0 ? 0 : Math.min(...metadataLengths), metadataMaxCharacters: metadataLengths.length === 0 ? 0 : Math.max(...metadataLengths), ...metrics }) + '\n')
} finally {
  await ctx.fiber.dispose()
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
}
