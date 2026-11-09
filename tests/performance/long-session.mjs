/** Long-session token/prefix controls crossing the default absolute budget. */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, '.artifacts/performance')
await mkdir(out, { recursive: true })
await build({ entry: [join(root, 'tests/performance/context-budget.perf.ts')], outDir: out, format: 'esm', platform: 'node', dts: false, clean: false, config: false })
const rows = []
for (const variant of ['baseline-plain', 'budgeted', 'budgeted-prune']) {
  const mode = variant === 'baseline-plain' ? variant : 'budgeted'
  const extra = variant === 'budgeted-prune' ? ['--prune', '--target-ratio=0.5'] : []
  const child = spawnSync(process.execPath, ['--expose-gc', join(out, 'context-budget.perf.mjs'), mode, '512', '--prefix', ...extra], { cwd: root, encoding: 'utf8', timeout: 60000 })
  if (child.error || child.signal || child.status !== 0) throw new Error(`long-session ${variant} failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
  const row = JSON.parse(child.stdout.trim())
  if (variant === 'budgeted' && row.summaryRequests === 0) throw new Error('long-session workload did not cross the default budget')
  rows.push({ variant, inputHeuristicTokens: row.inputHeuristicTokens, outputHeuristicTokens: row.outputHeuristicTokens,
    maxInputHeuristicTokens: row.maxInputHeuristicTokens, conversationRequests: row.conversationRequests, summaryRequests: row.summaryRequests,
    pruneEvents: row.pruneEvents, totalCharacters: row.prefixTotalCharacters, reusableCharacters: row.prefixReusedCharacters,
    newCharacters: row.prefixTotalCharacters - row.prefixReusedCharacters, reuseFraction: row.prefixReusedCharacters / row.prefixTotalCharacters })
}
const reference = rows[0]
for (const row of rows) {
  row.inputRatio = row.inputHeuristicTokens / reference.inputHeuristicTokens
  row.coldRefillRatio = row.newCharacters / reference.newCharacters
  row.theoreticalCostRatioAtCache002 = (row.newCharacters + .02 * row.reusableCharacters) / (reference.newCharacters + .02 * reference.reusableCharacters)
}
const report = { steps: 512, metric: 'all scripted conversation and summary request heuristics plus canonical JSON prefix characters; not real provider billing or model quality; prefix instrumentation timings intentionally not used as latency evidence', theoreticalCost: 'new character=1, reused character=.02; illustrative normalization, not provider prices', rows }
await writeFile(join(out, 'long-session.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
