/** Bounded transcript results from one explicit current-session history snapshot. */
import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Message, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-query'
import type { RecallConfig } from './config.ts'
import { decodeCursor, encodeCursor, fingerprint, invalidCursor } from './cursor.ts'
import type { RecallPosition } from './cursor.ts'

/** Inclusive original-event range and an optional continuation. */
export interface ReadArgs {
  startSeq: number
  endSeq?: number
  cursor?: string
}

/** Literal search over an optional inclusive event range. */
export interface SearchArgs {
  query: string
  startSeq?: number
  endSeq?: number
  cursor?: string
}

interface TranscriptRecord {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  readonly part: number
  readonly offset: number
  readonly text: string
  readonly isError?: boolean
}

type TranscriptMessage = Extract<Message, { readonly role: 'user' | 'assistant' | 'tool' }>

interface Page {
  readonly range: { readonly startSeq: number; readonly endSeq: number }
  readonly records: readonly TranscriptRecord[]
  readonly scannedEvents: number
  readonly scannedCharacters: number
  readonly complete: boolean
  readonly nextCursor?: string
}

interface Call {
  readonly events: readonly SessionEvent[]
  readonly start: RecallPosition
  readonly fits: (value: Page) => boolean
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HarnessError(`${field} must be a non-negative safe integer.`, 'CONTEXT_RECALL_INVALID_RANGE')
  }
  return value
}

async function callFor(
  ctx: Context, exec: ToolRunContext, args: ReadArgs | SearchArgs, mode: RecallPosition['mode'],
  limits: RecallConfig,
): Promise<Call> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('Context recall requires a session-bound agent.', 'CONTEXT_RECALL_MISSING_AGENT')
  }
  const boundary = ctx.agents.turnBoundaryOf(agent.session).lastStepStartSeq
  if (boundary === null || boundary === 0) {
    throw new HarnessError('No earlier completed step is available to recall.', 'CONTEXT_RECALL_INVALID_RANGE')
  }
  const query = 'query' in args ? args.query : ''
  const from = integer(args.startSeq ?? 0, 'startSeq')
  const to = integer(args.endSeq ?? (mode === 'read' ? from : boundary - 1), 'endSeq')
  const owner = agent.session.id
  const queryHash = fingerprint(query)
  let start: RecallPosition = { mode, owner, query: queryHash, from, to, seq: from, part: 0, offset: 0 }
  if (args.cursor !== undefined) {
    start = decodeCursor(args.cursor)
    if (start.owner !== owner || start.mode !== mode || start.query !== queryHash
      || start.from !== from || (args.endSeq !== undefined && start.to !== to)
      || (mode === 'read' && start.to !== to)) throw invalidCursor()
  }
  if (start.from > start.to || start.to >= boundary) {
    throw new HarnessError('Context ranges must precede the step making this call.', 'CONTEXT_RECALL_INVALID_RANGE')
  }
  const message = createToolResultMessage({ callId: exec.callId, isError: false, content: [] })
  // Accepted tool calls may finish after registration withdrawal. This estimator
  // is pure; capture it before the history read can yield or the context unloads.
  const estimateMessage = ctx.tokenMeter.estimateMessage.bind(ctx.tokenMeter)
  exec.signal.throwIfAborted()
  const snapshot = await ctx.sessionQuery.readSession(agent.session.id)
  exec.signal.throwIfAborted()
  return {
    events: snapshot.events,
    start,
    fits: (value) => {
      const text = JSON.stringify(value)
      const rendered: ToolResultMessage = { ...message, content: [{ type: 'text', text }] }
      return Buffer.byteLength(text, 'utf8') <= limits.maxOutputBytes
        && estimateMessage(rendered) <= limits.maxOutputTokens
    },
  }
}

function visible(event: SessionEvent): TranscriptMessage | null {
  switch (event.type) {
    case 'user/message': return event.data
    case 'assistant/message':
    case 'tool/result': return event.data.message
    default: return null
  }
}

function pieces(message: TranscriptMessage): string[] {
  return message.content.flatMap((block): string[] => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-call') return [`Tool call ${block.name}: ${block.arguments}`]
    return []
  })
}

/** Return a UTF-16 boundary without splitting a surrogate pair. */
function boundaryAt(text: string, offset: number): number {
  if (offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[offset] ?? '')) return offset - 1
  return offset
}

function fittingEnd(text: string, start: number, maximum: number, accepts: (end: number) => boolean): number {
  if (accepts(maximum)) return maximum
  let low = start
  let high = maximum
  while (low < high) {
    let end = boundaryAt(text, Math.ceil((low + high) / 2))
    if (end <= low) {
      end = Math.min(text.length, low + 2)
      if (end > high) { high = low; continue }
    }
    if (accepts(end)) low = end
    else high = end - 1
  }
  return boundaryAt(text, low)
}

function page(
  position: RecallPosition, records: readonly TranscriptRecord[], scannedEvents: number,
  scannedCharacters: number, next: RecallPosition | null,
): Page {
  return {
    range: { startSeq: position.from, endSeq: position.to }, records, scannedEvents, scannedCharacters,
    complete: next === null,
    ...next === null ? {} : { nextCursor: encodeCursor(next) },
  }
}

function nextEvent(position: RecallPosition): RecallPosition | null {
  return position.seq === position.to ? null : { ...position, seq: position.seq + 1, part: 0, offset: 0 }
}

function assertPosition(position: RecallPosition, segments: readonly string[]): void {
  if (position.part > segments.length) throw invalidCursor()
  const text = segments[position.part]
  if ((text === undefined && position.offset !== 0)
    || (text !== undefined && (position.offset > text.length || boundaryAt(text, position.offset) !== position.offset))) {
    throw invalidCursor()
  }
}

function recordFor(event: SessionEvent, message: TranscriptMessage, part: number, offset: number, text: string): TranscriptRecord {
  return {
    seq: event.seq, role: message.role, part, offset, text,
    ...message.role === 'tool' && message.isError === true ? { isError: true } : {},
  }
}

function eventFor(events: readonly SessionEvent[], position: RecallPosition): SessionEvent {
  const event = events[position.seq]
  if (event === undefined) throw invalidCursor()
  return event
}

/**
 * Read original visible text, retaining a continuation even inside one large block.
 * @param ctx - services owning the caller and message estimator.
 * @param args - inclusive original range and optional cursor.
 * @param exec - agent-bound tool invocation.
 * @param limits - complete-result and per-call scan budgets.
 * @returns bounded JSON text with exact event references and coverage.
 */
export async function readContext(ctx: Context, args: ReadArgs, exec: ToolRunContext, limits: RecallConfig): Promise<string> {
  const call = await callFor(ctx, exec, args, 'read', limits)
  const records: TranscriptRecord[] = []
  let position: RecallPosition | null = call.start
  let scannedEvents = 0
  let scannedCharacters = 0
  while (position !== null && scannedEvents < limits.maxScanEvents) {
    exec.signal.throwIfAborted()
    const event = eventFor(call.events, position)
    scannedEvents += 1
    const message = visible(event)
    if (message === null) { position = nextEvent(position); continue }
    const segments = pieces(message)
    assertPosition(position, segments)
    while (position.part < segments.length) {
      const text = segments[position.part] ?? ''
      if (text.length === 0) { position = { ...position, part: position.part + 1, offset: 0 }; continue }
      const offset = position.offset
      const maxTextUnits = Math.min(limits.maxOutputBytes, limits.maxOutputTokens * 4)
      const maximum = boundaryAt(text, Math.min(text.length, offset + maxTextUnits))
      const selected = position
      const end = fittingEnd(text, offset, maximum, proposed => {
        const next = proposed === text.length
          ? selected.part + 1 === segments.length ? nextEvent(selected) : { ...selected, part: selected.part + 1, offset: 0 }
          : { ...selected, offset: proposed }
        const candidate = recordFor(event, message, selected.part, offset, text.slice(offset, proposed))
        return call.fits(page(call.start, [...records, candidate], scannedEvents, scannedCharacters + proposed - offset, next))
      })
      if (end === offset && text.length > offset) {
        const result = page(call.start, records, scannedEvents, scannedCharacters, position)
        if (records.length === 0 || !call.fits(result)) throw budgetFailure()
        return JSON.stringify(result)
      }
      if (end > offset || text.length === 0) {
        records.push(recordFor(event, message, position.part, offset, text.slice(offset, end)))
        scannedCharacters += end - offset
      }
      if (end < text.length) return JSON.stringify(page(call.start, records, scannedEvents, scannedCharacters, { ...position, offset: end }))
      position = { ...position, part: position.part + 1, offset: 0 }
    }
    position = nextEvent(position)
  }
  const result = page(call.start, records, scannedEvents, scannedCharacters, position)
  if (!call.fits(result)) throw budgetFailure()
  return JSON.stringify(result)
}

/**
 * Search original visible text with explicit event and character coverage.
 * @param ctx - services owning the caller and message estimator.
 * @param args - nonempty case-sensitive literal query and optional range/cursor.
 * @param exec - agent-bound tool invocation.
 * @param limits - complete-result and per-call scan budgets.
 * @returns bounded JSON snippets with a continuation for unscanned history.
 */
export async function searchContext(ctx: Context, args: SearchArgs, exec: ToolRunContext, limits: RecallConfig): Promise<string> {
  if (args.query.trim().length === 0 || args.query.length > limits.maxQueryCharacters) {
    throw new HarnessError(`query must contain 1–${limits.maxQueryCharacters} characters.`, 'CONTEXT_RECALL_INVALID_QUERY')
  }
  const call = await callFor(ctx, exec, args, 'search', limits)
  const records: TranscriptRecord[] = []
  let position: RecallPosition | null = call.start
  let scannedEvents = 0
  let scannedCharacters = 0
  while (position !== null && scannedEvents < limits.maxScanEvents && scannedCharacters < limits.maxScanCharacters) {
    exec.signal.throwIfAborted()
    const event = eventFor(call.events, position)
    scannedEvents += 1
    const message = visible(event)
    if (message === null) { position = nextEvent(position); continue }
    const segments = pieces(message)
    assertPosition(position, segments)
    while (position.part < segments.length && scannedCharacters < limits.maxScanCharacters) {
      const text = segments[position.part] ?? ''
      const end = boundaryAt(text, Math.min(text.length, position.offset + limits.maxScanCharacters - scannedCharacters))
      if (end < text.length && end - position.offset < args.query.length) {
        const result = page(call.start, records, scannedEvents, scannedCharacters, position)
        if (!call.fits(result)) throw budgetFailure()
        return JSON.stringify(result)
      }
      const window = text.slice(position.offset, end)
      const match = window.indexOf(args.query)
      const scanned = end - position.offset
      if (match >= 0) {
        const start = boundaryAt(text, position.offset + match)
        const snippetEnd = boundaryAt(text, Math.min(end, start + limits.snippetCharacters,
          start + limits.maxOutputBytes, start + limits.maxOutputTokens * 4))
        let record = recordFor(event, message, position.part, start, text.slice(start, snippetEnd))
        const next = end < text.length ? { ...position, offset: Math.max(position.offset + 1, end - args.query.length + 1) }
          : position.part + 1 === segments.length ? nextEvent(position) : { ...position, part: position.part + 1, offset: 0 }
        if (records.length === 0 && !call.fits(page(call.start, [record], scannedEvents, scannedCharacters + scanned, next))) {
          const selected = position
          const selectedEnd = fittingEnd(text, start, snippetEnd, proposed => {
            const candidate = recordFor(event, message, selected.part, start, text.slice(start, proposed))
            return call.fits(page(call.start, [candidate], scannedEvents, scannedCharacters + scanned, next))
          })
          record = recordFor(event, message, position.part, start, text.slice(start, selectedEnd))
        }
        if (record.text.length === 0 || !call.fits(page(call.start, [...records, record], scannedEvents, scannedCharacters + scanned, next))) {
          const result = page(call.start, records, scannedEvents, scannedCharacters, position)
          if (records.length === 0 || !call.fits(result)) throw budgetFailure()
          return JSON.stringify(result)
        }
        records.push(record)
      }
      scannedCharacters += scanned
      if (end < text.length) {
        const offset = boundaryAt(text, Math.max(position.offset + 1, end - args.query.length + 1))
        return JSON.stringify(page(call.start, records, scannedEvents, scannedCharacters, { ...position, offset }))
      }
      position = { ...position, part: position.part + 1, offset: 0 }
    }
    if (position.part < segments.length) break
    position = nextEvent(position)
  }
  const result = page(call.start, records, scannedEvents, scannedCharacters, position)
  if (!call.fits(result)) throw budgetFailure()
  return JSON.stringify(result)
}

function budgetFailure(): HarnessError {
  return new HarnessError('Context result metadata exceeds its output budget. Increase the recall output limits.', 'CONTEXT_RECALL_BUDGET_TOO_SMALL')
}
