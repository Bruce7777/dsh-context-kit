/** Canonical request-prefix controls, separate from uninstrumented timing samples. */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, '.artifacts/performance')
await mkdir(out, { recursive: true })
await build({ entry: [join(root, 'tests/performance/context-budget.perf.ts')], outDir: out, format: 'esm', platform: 'node', dts: false, clean: false, config: false })
const controls = []
for (const steps of [8, 96]) {
  for (const mode of ['baseline-plain', 'baseline', 'budgeted']) {
    const child = spawnSync(process.execPath, ['--expose-gc', join(out, 'context-budget.perf.mjs'), mode, String(steps), '--prefix'], { cwd: root, encoding: 'utf8', timeout: 30000 })
    if (child.error || child.signal || child.status !== 0) throw new Error(`prefix control ${mode}/${steps} failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
    const row = JSON.parse(child.stdout.trim())
    controls.push({ mode, steps, totalCharacters: row.prefixTotalCharacters, reusableCharacters: row.prefixReusedCharacters,
      newCharacters: row.prefixTotalCharacters - row.prefixReusedCharacters, reuseFraction: row.prefixReusedCharacters / row.prefixTotalCharacters })
  }
}
const costScenarios = []
for (const steps of [8, 96]) {
  const reference = controls.find(row => row.steps === steps && row.mode === 'baseline-plain')
  const candidate = controls.find(row => row.steps === steps && row.mode === 'budgeted')
  for (const cachedUnitRatio of [0, 0.01, 0.02, 0.1, 0.25, 1]) {
    const referenceUnits = reference.newCharacters + cachedUnitRatio * reference.reusableCharacters
    const candidateUnits = candidate.newCharacters + cachedUnitRatio * candidate.reusableCharacters
    costScenarios.push({ steps, cachedUnitRatio, referenceUnits, candidateUnits, candidateToReference: candidateUnits / referenceUnits })
  }
}
const report = { metric: 'exact common prefix of canonical tools/system/model-message JSON, identity/source fields omitted; characters are not tokenizer tokens and do not establish provider cache hits or billed cost', timing: 'diagnostic serialization is excluded from the separate performance report; these instrumented timings are intentionally not reported', costModel: 'illustrative normalized character units: new=1, reused=r, no cache-write pricing or provider quotation; real billing requires actual reported usage', controls, costScenarios }
await writeFile(join(out, 'prefix.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
