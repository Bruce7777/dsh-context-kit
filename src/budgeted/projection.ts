/** Bounded tool previews and current-surface metadata for replayable budget policy. @module */
import { z } from 'zod'
import { isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const previewSchema = z.object({
  turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
  callId: z.string().transform(ToolCallId), messageId: z.string().transform(MessageId), text: z.string(),
  originalTokens: z.number().int().nonnegative(), previewTokens: z.number().int().nonnegative(),
  hasErrorFlag: z.boolean(), meta: z.json().optional(),
}).strict()
const nodeSchema = z.object({
  seq: z.number().int().nonnegative().transform(SessionSeq),
  messageId: z.string().transform(MessageId).nullable(),
  stepOrdinal: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(),
  tool: z.boolean(), system: z.boolean(), preview: previewSchema.nullable(),
}).strict()
const surfaceSchema = z.object({
  headChars: z.number().int().nonnegative(), tailChars: z.number().int().nonnegative(),
  metaMaxChars: z.number().int().nonnegative(), previewsEnabled: z.boolean(),
  completedSteps: z.number().int().nonnegative(), activeCompaction: z.boolean(),
  toolTokens: z.number().int().nonnegative(), nodes: z.array(nodeSchema),
}).strict()

/** Content-free current nodes and bounded previews; original bulk stays only in Session. */
export type BudgetSurfaceState = z.infer<typeof surfaceSchema>

/** Pure estimator and preview limits captured by one projection registration. */
export interface PreviewPolicy {
  readonly enabled: boolean
  readonly headChars: number
  readonly tailChars: number
  readonly metaMaxChars: number
  readonly estimateMessage: (message: Message) => number
}

/**
 * Build a replay-only metadata fold. A changed preview policy invalidates its checkpoint.
 * @param policy - validated text limits and the host's pure message estimator.
 * @returns definition retaining only current nodes and bounded successful-text previews.
 */
export function createBudgetSurfaceProjection(policy: PreviewPolicy): ProjectionDefinition<'contextKitBudgetSurface', BudgetSurfaceState> {
  return {
    key: 'contextKitBudgetSurface', stateVersion: 4,
    stateSchema: surfaceSchema.refine(state => state.headChars === policy.headChars && state.tailChars === policy.tailChars && state.metaMaxChars === policy.metaMaxChars && state.previewsEnabled === policy.enabled),
    init: () => ({ headChars: policy.headChars, tailChars: policy.tailChars, metaMaxChars: policy.metaMaxChars, previewsEnabled: policy.enabled,
      completedSteps: 0, activeCompaction: false, toolTokens: 0, nodes: [] }),
    apply: (state, event) => {
      if (event.type === 'step/end') return { ...state, completedSteps: state.completedSteps + 1 }
      if (event.type === 'compaction/start') return { ...state, activeCompaction: true }
      if (event.type === 'compaction/end' || event.type === 'session/end-seed') return { ...state, activeCompaction: false }
      if (!isSurfaceEvent(event)) return state
      const messageId = event.type === 'user/message' ? event.data.id : event.data.message.id
      const message = event.type === 'tool/result' ? event.data.message : undefined
      const node = {
        seq: event.seq, messageId, stepOrdinal: state.completedSteps + 1,
        tokens: message === undefined || !policy.enabled ? 0 : policy.estimateMessage(message),
        tool: event.type === 'tool/result', system: event.type === 'system/message',
        preview: policy.enabled && event.type === 'tool/result' ? previewOf(event, policy) : null,
      }
      const op = event.surfaceOp
      if (op === 'append') return { ...state, nodes: [...state.nodes, node], toolTokens: state.toolTokens + node.tokens }
      const from = state.nodes.findIndex(candidate => candidate.seq === op.startSeq)
      const to = state.nodes.findIndex(candidate => candidate.seq === op.endSeq)
      const first = state.nodes[from]
      if (first === undefined || to < from) throw new Error('context kit: replacement references absent surface nodes')
      const removed = state.nodes.slice(from, to + 1).reduce((sum, value) => sum + value.tokens, 0)
      return { ...state, toolTokens: state.toolTokens - removed + node.tokens,
        nodes: [...state.nodes.slice(0, from), { ...node, stepOrdinal: first.stepOrdinal }, ...state.nodes.slice(to + 1)] }
    },
  }
}

function previewOf(event: SessionEvent<'tool/result'>, policy: PreviewPolicy): BudgetSurfaceState['nodes'][number]['preview'] {
  const message = event.data.message
  if (message.isError === true || (event.data.meta !== undefined && JSON.stringify(event.data.meta).length > policy.metaMaxChars)
    || Object.keys(message).some(key => !['id', 'role', 'source', 'toolCallId', 'content', 'isError'].includes(key))
    || Object.keys(message.source).some(key => !['kind', 'callId'].includes(key))
    || message.content.some(block => block.type !== 'text')) return null
  const only = message.content.length === 1 ? message.content[0] : undefined
  const text = only?.type === 'text' ? only.text
    : message.content.map(block => block.type === 'text' ? block.text : '').join('')
  const marker = `\n\n[Tool result shortened. Original: context_read({"startSeq":${event.seq}})]\n\n`
  const points = /[\uD800-\uDFFF]/u.test(text) ? Array.from(text) : undefined
  if ((points?.length ?? text.length) <= policy.headChars + policy.tailChars + marker.length) return null
  const head = points === undefined ? text.slice(0, policy.headChars) : points.slice(0, policy.headChars).join('')
  const tail = policy.tailChars === 0 ? '' : points === undefined ? text.slice(-policy.tailChars) : points.slice(-policy.tailChars).join('')
  const shortened = head + marker + tail
  const replacement: Message = { ...message, content: [{ type: 'text', text: shortened }] }
  const originalTokens = policy.estimateMessage(message)
  const previewTokens = policy.estimateMessage(replacement)
  if (previewTokens >= originalTokens) return null
  return { turn: event.data.turn, step: event.data.step, callId: message.toolCallId, messageId: message.id,
    text: shortened, originalTokens, previewTokens, hasErrorFlag: message.isError !== undefined,
    ...event.data.meta === undefined ? {} : { meta: event.data.meta } }
}
