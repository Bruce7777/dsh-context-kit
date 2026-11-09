/** Current-session text recall tools for compressed and pruned conversation history. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from './config.ts'
import { readContext, searchContext } from './operations.ts'

export { Config } from './config.ts'

/** Cordis plugin identity. */
export const name = 'tool-context-recall'

/** Services used by the caller-scoped tools and complete-result token budget. */
export const inject = ['tools', 'agents', 'tokenMeter', 'sessionQuery']

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Register bounded original-history search and read tools.
 * @param ctx - plugin context owning all reversible registrations.
 * @param config - optional deployment limits; defaults apply to absent fields.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveConfig(config)
  ctx.tools.register(defineTool({
    name: 'context_read',
    description: "Read this session's earlier text before guessing. Follow summary/prune refs. Inclusive seqs; end defaults to start. Continue with nextCursor and the same range.",
    parameters: {
      startSeq: { type: 'integer', required: true },
      endSeq: { type: 'integer' },
      cursor: { type: 'string' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => readContext(ctx, args, exec, limits),
    presentCall: args => ({ card: 'generic', title: 'Read conversation context', kind: 'read', rawInput: `${args.startSeq}–${args.endSeq ?? args.startSeq}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'context_search',
    description: "Find a case-sensitive literal in this session's earlier text, including hidden originals. Read matching seqs with context_read. complete:false: continue nextCursor with the same query/range.",
    parameters: {
      query: { type: 'string', required: true },
      startSeq: { type: 'integer' },
      endSeq: { type: 'integer' },
      cursor: { type: 'string' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => searchContext(ctx, args, exec, limits),
    presentCall: args => ({ card: 'generic', title: 'Search conversation context', kind: 'search', rawInput: args.query }),
  }))
}
