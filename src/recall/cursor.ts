/** Range-bound continuation positions for immutable Session history. */
import { createHash } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** One continuation position within an explicitly frozen event range. */
export interface RecallPosition {
  readonly mode: 'read' | 'search'
  readonly owner: SessionId
  readonly query: string
  readonly from: number
  readonly to: number
  readonly seq: number
  readonly part: number
  readonly offset: number
}

/**
 * Bind a continuation to its literal query without copying the query text.
 * @param value - exact search query.
 * @returns stable SHA-256 fingerprint.
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

/**
 * Encode the next unread position. The clear session-id prefix supports
 * identity normalization during replay; the payload contains no transcript text.
 * @param position - validated range and code-point-aligned text position.
 * @returns URL-safe continuation token.
 */
export function encodeCursor(position: RecallPosition): string {
  const { owner, ...payload } = position
  return `${owner}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

/**
 * Decode a cursor supplied at the model/tool JSON boundary.
 * @param value - untrusted cursor string.
 * @returns validated continuation fields.
 * @throws HarnessError for malformed tokens or impossible positions.
 */
export function decodeCursor(value: string): RecallPosition {
  const separator = value.lastIndexOf('.')
  if (value.length > 1024 || separator < 1) throw invalidCursor()
  const owner = value.slice(0, separator)
  const payload = value.slice(separator + 1)
  if (!/^[\w-]+$/u.test(payload)) throw invalidCursor()
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (_error) {
    // Only model-supplied cursor JSON is parsed here.
    throw invalidCursor()
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor()
  const fields = decoded as Record<string, unknown>
  if (Object.keys(fields).length !== 7
    || (fields.mode !== 'read' && fields.mode !== 'search')
    || typeof fields.query !== 'string' || !/^[\w-]{43}$/u.test(fields.query)) throw invalidCursor()
  const numberAt = (key: string): number => {
    const candidate = fields[key]
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) throw invalidCursor()
    return candidate
  }
  const position: RecallPosition = {
    mode: fields.mode, owner: SessionId(owner), query: fields.query,
    from: numberAt('from'), to: numberAt('to'), seq: numberAt('seq'),
    part: numberAt('part'), offset: numberAt('offset'),
  }
  if (position.from > position.to || position.seq < position.from || position.seq > position.to) throw invalidCursor()
  return position
}

/**
 * Reject a cursor without exposing its encoded contents.
 * @returns stable model-facing input failure.
 */
export function invalidCursor(): HarnessError {
  return new HarnessError('Invalid context continuation. Repeat the original call without cursor.', 'CONTEXT_RECALL_INVALID_CURSOR')
}
