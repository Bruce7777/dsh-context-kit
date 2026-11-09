/** Fixed external-model boundary and real tool used by the profile replay. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'context-budget-snapshot-workload'
export const inject = ['llm', 'tools']

class WorkloadAdapter extends LlmAdapter {
  phase = 0
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1048576 }, defaultMaxTokens: 8192 })
  }
  async * stream(options) {
    let text
    let call
    if (options.purpose === 'compaction') {
      text = 'Build inspection continues. Recover exact omitted release metadata from original records when needed.'
    } else if (this.phase < 20) {
      call = { name: 'inspect_build', arguments: JSON.stringify({ index: this.phase }) }
      this.phase += 1
    } else if (this.phase === 20) {
      call = { name: 'context_search', arguments: JSON.stringify({ query: 'artifact-tag' }) }
      this.phase += 1
    } else {
      const result = options.messages.findLast(message => message.role === 'tool')
      const rendered = result?.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (rendered === undefined) throw new Error('snapshot has no recall result')
      const page = JSON.parse(rendered)
      if (this.phase === 21) {
        const hit = page.records.find(record => record.text.includes('artifact-tag='))
        if (hit === undefined) throw new Error('snapshot search missed original artifact-tag')
        call = { name: 'context_read', arguments: JSON.stringify({ startSeq: hit.seq }) }
        this.phase += 1
      } else {
        text = /artifact-tag=([^\s;]+)/u.exec(page.records.map(record => record.text).join(''))?.[1]
        if (text === undefined) throw new Error('snapshot read lost the original artifact value')
      }
    }
    const block = call === undefined
      ? { type: 'text', text }
      : { type: 'tool-call', id: ToolCallId(`snapshot-work-${this.phase}`), ...call }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: call === undefined ? 'stop' : 'tool-calls' } }
  }
}

/**
 * Register the synthetic read-only capability and restrict the fixture agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - real Loader context.
 * @param {{scriptedModel?: boolean}} config - record-only model boundary.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'inspect_build', description: 'Read one fixed synthetic build record; each index is read once.',
    parameters: { index: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(`Build ${args.index}\n`
      + `module-${args.index}: validation passed\n`.repeat(90)
      + (args.index === 1 ? 'artifact-tag=azure-falcon-42\n' : '')
      + `module-${args.index}: metadata verified\n`.repeat(90) + `END ${args.index}`),
  }))
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['inspect_build', 'context_read', 'context_search'] })
  })
  if (config.scriptedModel) ctx.llm.registerAdapter(['context-fixture'], new WorkloadAdapter())
}
