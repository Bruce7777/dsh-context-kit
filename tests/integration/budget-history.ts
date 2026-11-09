/** Fixed coding-history fixtures for context-budget integration and fidelity checks. */
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

export const HISTORY_FACTS = {
  artifactTag: 'azure-falcon-42',
  retryLimit: 7,
  retryError: 'E_BUILD_LOCK',
  protectedFile: 'config/production.yml',
} as const

/**
 * Build completed synthetic tool steps with exact facts in an old result's
 * middle, beyond the normal head/tail previews. Originals are the oracle.
 * @param steps - number of completed tool steps.
 * @returns seed events suitable for the production AgentLoop.
 */
export function budgetHistory(steps = 20): readonly SessionEvent[] {
  const session = Session.create(SessionId('budget-history-fixture'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: `Inspect build outputs. Never modify ${HISTORY_FACTS.protectedFile}. Keep exact release values retrievable from the original build records.` }],
  }), { surfaceOp: 'append' })
  session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192 } }, reason: 'initial' })
  for (let step = 1; step <= steps; step += 1) {
    const callId = ToolCallId(`build-${step}`)
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', {
      turn: 1, step, stream: [],
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [{ type: 'tool-call', id: callId, name: 'inspect_build', arguments: JSON.stringify({ index: step }) }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step, callId, name: 'inspect_build', arguments: JSON.stringify({ index: step }) })
    const text = `Build record ${step}\n` + `source module ${step}: validation passed\n`.repeat(65)
      + (step === 2 ? `artifact-tag=${HISTORY_FACTS.artifactTag}\n` : '')
      + (step === 3 ? `retry-error=${HISTORY_FACTS.retryError}; retry-limit=${HISTORY_FACTS.retryLimit}\n` : '')
      + `source module ${step}: output metadata verified\n`.repeat(65) + `END ${step}`
    session.append('tool/result', {
      turn: 1, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: step === 3 }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.snapshotEvents()
}
