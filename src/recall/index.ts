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
    description: 'Read earlier originals in this session. Use hit.read or summary seqs; end=start. part indexes text; offset is UTF-16. Continue cursor with same seqs.',
    parameters: {
      startSeq: { type: 'integer', required: true },
      endSeq: { type: 'integer' },
      part: { type: 'integer' },
      offset: { type: 'integer' },
      cursor: { type: 'string' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => readContext(ctx, args, exec, limits),
    presentCall: args => ({ card: 'generic', title: 'Read conversation context', kind: 'read', rawInput: `${args.startSeq}–${args.endSeq ?? args.startSeq}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'context_search',
    description: 'Find case-sensitive text in earlier session originals before guessing. Omit seqs for all history. Expand hit.read; complete:false: continue cursor with same query.',
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
