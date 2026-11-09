/** Run built-product context-budget diagnostics in independent Node processes. */
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
for (const steps of [8, 96]) {
  for (const mode of ['baseline-plain', 'baseline', 'budgeted']) {
    for (let sample = 0; sample < 3; sample += 1) {
      const child = spawnSync(process.execPath, ['--expose-gc', join(out, 'context-budget.perf.mjs'), mode, String(steps)], { cwd: root, encoding: 'utf8', timeout: 30000 })
      if (child.error || child.signal || child.status !== 0) throw new Error(`diagnostic ${mode}/${steps} failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
      const row = JSON.parse(child.stdout.trim())
      rows.push({ sample: sample + 1, ...row })
    }
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summaries = []
for (const steps of [8, 96]) {
  for (const mode of ['baseline-plain', 'baseline', 'budgeted']) {
    const samples = rows.filter(row => row.steps === steps && row.mode === mode)
    summaries.push({ steps, mode, samples: samples.length, inputHeuristicTokens: samples[0].inputHeuristicTokens, outputHeuristicTokens: samples[0].outputHeuristicTokens,
      maxInputHeuristicTokens: samples[0].maxInputHeuristicTokens, conversationRequests: samples[0].conversationRequests, summaryRequests: samples[0].summaryRequests,
      medianWallMs: median(samples.map(row => row.wallMs)), medianCpuMs: median(samples.map(row => row.cpuMs)), medianRetainedHeapDelta: median(samples.map(row => row.retainedHeapDelta)), medianRss: median(samples.map(row => row.rss)), medianPeakRss: median(samples.map(row => row.peakRss)) })
  }
}
const report = { runtime: process.version, platform: process.platform, arch: process.arch, model: 'scripted; no model/network latency', tokenCounts: 'heuristic, including all auxiliary summary requests; not provider billing', rows, summaries }
await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(summaries, null, 2) + '\n')
