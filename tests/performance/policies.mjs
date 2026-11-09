/** Compare explicit batch policies against the same synthetic workload. */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, '.artifacts/performance')
await mkdir(out, { recursive: true })
await build({ entry: [join(root, 'tests/performance/context-budget.perf.ts')], outDir: out, format: 'esm', platform: 'node', dts: false, clean: false, config: false })
function run(mode, policy = []) {
  const child = spawnSync(process.execPath, ['--expose-gc', join(out, 'context-budget.perf.mjs'), mode, '96', '--prefix', ...(mode === 'budgeted' ? ['--prune'] : []), ...policy], { cwd: root, encoding: 'utf8', timeout: 30000 })
  if (child.error || child.signal || child.status !== 0) throw new Error(`policy diagnostic failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
  const row = JSON.parse(child.stdout.trim())
  return { mode, targetRatio: row.targetRatio, minSavings: row.minSavings, inputHeuristicTokens: row.inputHeuristicTokens,
    maxInputHeuristicTokens: row.maxInputHeuristicTokens, totalCharacters: row.prefixTotalCharacters,
    reusableCharacters: row.prefixReusedCharacters, newCharacters: row.prefixTotalCharacters - row.prefixReusedCharacters,
    reuseFraction: row.prefixReusedCharacters / row.prefixTotalCharacters, summaries: row.summaryRequests }
}
const reference = run('baseline-plain')
const rows = []
for (const ratio of [0.75, 0.5, 0.25]) {
  for (const minimum of [1024, 4096, 8192]) {
    const row = run('budgeted', [`--target-ratio=${ratio}`, `--min-savings=${minimum}`])
    const units = r => (row.newCharacters + r * row.reusableCharacters) / (reference.newCharacters + r * reference.reusableCharacters)
    rows.push({ ...row, inputRatio: row.inputHeuristicTokens / reference.inputHeuristicTokens, coldRefillRatio: row.newCharacters / reference.newCharacters,
      theoreticalCostRatioAtCache001: units(0.01), theoreticalCostRatioAtCache002: units(0.02), theoreticalCostRatioAtCache01: units(0.1) })
  }
}
const report = { metric: 'synthetic canonical request-prefix characters, not tokenizer/cache/billing measurements; the cache/new unit ratios .01 and .1 are illustrative, not price quotations; instrumented timings are excluded', reference, rows }
await writeFile(join(out, 'policies.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
