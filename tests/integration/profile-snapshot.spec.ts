/** Recorded-session round trip through the installed DSH headless profile. */
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot,
  latestPersistedSessionPaths, normalizeSessionSnapshots, normalizedSystemPrompts,
  normalizedToolSchemas, redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'

const runFile = promisify(execFile)
const require = createRequire(import.meta.url)
const fixtureDir = fileURLToPath(new URL('../snapshots/context-budget-recall/', import.meta.url))
const fixture = join(fixtureDir, 'session.v5.jsonl')
const task = 'Inspect the twenty build records in order, then recover the exact artifact-tag from the original archived record using context_search and context_read. Do not guess or regenerate it. Preserve config/production.yml. Answer only with the recovered tag.'

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]))).flat()
}

async function launch(record: boolean): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-profile-'))
  try {
    const bin = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
    const patch = join(cwd, 'context.patch.yml')
    const modulePath = (name: string) => JSON.stringify(fileURLToPath(import.meta.resolve(name)))
    await writeFile(patch, [
      '- id: llm-deepseek\n  disabled: true',
      '- id: llm-deepseek-account\n  disabled: true',
      '- id: session-title-llm\n  disabled: true',
      '- id: agent-instructions\n  disabled: true',
      '- id: compaction-basic\n  disabled: true',
      '- id: agent-default-model\n  config:\n    provider: context-fixture\n    model: fixture',
      '- id: system-prompt\n  config:\n    personaPrefix: Follow the user exactly. Recover missing facts from original records.',
      "- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: none",
      '- insert:',
      `    - id: context-recall\n      name: ${modulePath('dsh-context-kit/recall')}\n      config:\n        maxScanCharacters: 1000000`,
      `    - id: context-budgeted\n      name: ${modulePath('dsh-context-kit/budgeted')}\n      config:\n        pruneToolResults: true\n        maxContextTokens: 6000\n        toolHistoryTokens: 2400\n        retainTokens: 1024\n        protectedSteps: 2\n        minSavingsTokens: 128\n        summaryTargetTokens: 512\n        maxTokens: 8192\n        headroomTokens: 0`,
      `    - id: context-workload\n      name: ${JSON.stringify(join(fixtureDir, 'workload.mjs'))}\n      config:\n        scriptedModel: ${record}`,
      ...record ? [] : [
        `    - id: context-replay\n      name: ${modulePath('@deepseek-ai/dsh-llm-replay')}\n      config:\n        file: ${JSON.stringify(fixture)}\n        providers:\n          - id: context-fixture\n            name: Context fixture\n            models:\n              - id: fixture\n                contextWindow: 1048576\n                defaultMaxTokens: 8192`,
      ],
    ].join('\n\n') + '\n')
    const result = await runFile(process.execPath, [bin, '--profile', 'headless', '--patch', patch, '--permission-mode', 'danger-full-access', '--approval-policy', 'never', task], {
      cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: join(cwd, '.dsh'), DEEPSEEK_API_KEY: 'snapshot-replay-key', DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    })
    expect(result.stdout.trim()).toBe('azure-falcon-42')
    const paths = latestPersistedSessionPaths(await filesUnder(join(cwd, '.dsh/sessions')))
    expect(paths).toHaveLength(1)
    return await readFile(paths[0]!, 'utf8')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('installed profile context-budget snapshot', () => {
  it('replays compression, pruning, and exact recall from the recorded session', async () => {
    const record = process.env.DSH_CONTEXT_SNAPSHOT === 'record'
    const raw = await launch(record)
    const actualContext = fixtureContext(raw)
    if (record) {
      const stable = tokenizeSessionFixtureCwd(raw)
      const [output] = redactSessionSnapshotIds([scrubSessionSnapshot(prepareSessionSnapshotFixtureForComparison(stable))])
      await writeFile(fixture, output!)
      const prompts = normalizedSystemPrompts(raw, actualContext)
      const schemas = normalizedToolSchemas(raw, actualContext)
      await writeFile(join(fixtureDir, 'system-prompt.expected.md'), formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1)))
      await writeFile(join(fixtureDir, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1)))
    }
    const expected = await readFile(fixture, 'utf8')
    expect(normalizeSessionSnapshots([raw], actualContext, { nativeWriterOutput: true }))
      .toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected), { nativeWriterOutput: true }))
    const records = raw.trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: { name?: string } })
    expect(records.filter(row => row.type === 'compaction/summary').length).toBeGreaterThan(1)
    expect(records.some(row => row.type === 'compaction/prune')).toBe(true)
    expect(records.filter(row => row.type === 'tool/call').slice(-2).map(row => row.data?.name)).toEqual(['context_search', 'context_read'])
  }, 45000)
})
