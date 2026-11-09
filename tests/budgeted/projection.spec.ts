import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createBudgetSurfaceProjection } from '../../src/budgeted/projection.js'

function fixture(): { session: Session; events: SessionEvent[]; result: SessionEvent<'tool/result'> } {
  const session = Session.create(SessionId('preview-projection'))
  const events: SessionEvent[] = []
  events.push(session.append('turn/start', { turn: 1 }))
  events.push(session.append('step/start', { turn: 1, step: 1 }))
  const callId = ToolCallId('inspect-1')
  events.push(session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
    role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }],
  }) }, { surfaceOp: 'append' }))
  events.push(session.append('tool/call', { turn: 1, step: 1, callId, name: 'inspect', arguments: '{}' }))
  const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId, isError: false, content: [{ type: 'text', text: `😀head ${'bulky-private-original '.repeat(1000)} tail🌊` }],
  }) }, { surfaceOp: 'append' })
  events.push(result)
  events.push(session.append('step/end', { turn: 1, step: 1 }))
  return { session, events, result }
}

function definition(headChars = 8, tailChars = 6) {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  return createBudgetSurfaceProjection({ enabled: true, headChars, tailChars, metaMaxChars: 128, estimateMessage: message => meter.estimateMessage(message) })
}

describe('bounded preview projection', () => {
  it('stores Unicode-safe bounded text and exact identities without original bulk', () => {
    const { events, result } = fixture()
    const unit = definition()
    const state = events.reduce(unit.apply, unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0)))
    const preview = state.nodes.find(node => node.seq === result.seq)?.preview
    expect(preview?.text).toContain('😀head ')
    expect(preview?.text).toContain('tail🌊')
    expect(preview?.text).toContain(`context_read({"startSeq":${result.seq}})`)
    expect(preview?.text).not.toContain('bulky-private-original')
    expect(preview?.messageId).toBe(result.data.message.id)
    expect(preview?.callId).toBe(result.data.message.toolCallId)
    expect(JSON.stringify(state).length).toBeLessThan(1000)
  })

  it('protects errors, oversized metadata and rich content', () => {
    const { result } = fixture()
    const unit = definition()
    const variants: SessionEvent<'tool/result'>[] = [
      { ...result, data: { ...result.data, message: { ...result.data.message, isError: true } } },
      { ...result, data: { ...result.data, meta: { bulk: 'opaque '.repeat(100) } } },
      { ...result, data: { ...result.data, message: { ...result.data.message,
        content: [...result.data.message.content, { type: 'reasoning', text: 'private rich data' } as ContentBlock] } } },
    ]
    for (const event of variants) expect(unit.apply(unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0)), event).nodes[0]?.preview).toBeNull()
  })

  it('keeps small metadata complete inside its preview budget', () => {
    const { result } = fixture()
    const unit = definition()
    const meta = { cwd: '/synthetic', path: 'src/build.ts' }
    const event = { ...result, data: { ...result.data, meta } }
    expect(unit.apply(unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0)), event).nodes[0]?.preview?.meta).toEqual(meta)
  })

  it('removes replaced nodes and preserves aging after nonmonotonic sequence replacements', () => {
    const { session, events, result } = fixture()
    const unit = definition()
    const before = events.reduce(unit.apply, unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0)))
    const replacement = session.append('tool/result', { ...result.data, message: {
      ...result.data.message, content: [{ type: 'text', text: 'small retained result' }],
    } }, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
    const after = unit.apply(before, replacement)
    expect(after.nodes.some(node => node.seq === result.seq)).toBe(false)
    expect(after.nodes.at(-1)?.seq).toBe(replacement.seq)
    expect(after.nodes.at(-1)?.stepOrdinal).toBe(before.nodes.at(-1)?.stepOrdinal)
    expect(after.toolTokens).toBeLessThan(before.toolTokens)
    expect(after.nodes.at(-1)?.preview).toBeNull()
  })

  it('restores a checkpoint and suffix identically to full replay', () => {
    const { events } = fixture()
    const unit = definition()
    const prefix = events.slice(0, -1).reduce(unit.apply, unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0)))
    const restored = unit.stateSchema.parse(JSON.parse(JSON.stringify(prefix)))
    expect(events.slice(-1).reduce(unit.apply, restored)).toEqual(events.reduce(unit.apply, unit.init(Session.create(SessionId('projection-initial')).header, SessionLogOffset(0))))
    expect(definition(9, 6).stateSchema.safeParse(restored).success).toBe(false)
  })
})
