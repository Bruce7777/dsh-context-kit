/** Real read/bash output and metadata controls; model/network latency is excluded. */
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
for (const tool of ['read', 'bash']) {
  for (const variant of ['baseline-plain', 'budgeted', 'budgeted-prune']) {
    for (let sample = 0; sample < 3; sample += 1) {
      const mode = variant === 'baseline-plain' ? variant : 'budgeted'
      const extra = variant === 'budgeted-prune' ? ['--prune', '--target-ratio=0.5'] : []
      const child = spawnSync(process.execPath, ['--expose-gc', join(out, 'context-budget.perf.mjs'), mode, '96', `--tool=${tool}`, ...extra], { cwd: root, encoding: 'utf8', timeout: 30000 })
      if (child.error || child.signal || child.status !== 0) throw new Error(`real-tool ${tool}/${variant} failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
      rows.push({ variant, sample: sample + 1, ...JSON.parse(child.stdout.trim()) })
    }
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summaries = []
for (const tool of ['read', 'bash']) {
  for (const variant of ['baseline-plain', 'budgeted', 'budgeted-prune']) {
    const group = rows.filter(row => row.toolKind === tool && row.variant === variant)
    summaries.push({ tool, variant, samples: group.length, inputHeuristicTokens: group[0].inputHeuristicTokens, maxInputHeuristicTokens: group[0].maxInputHeuristicTokens,
      conversationRequests: group[0].conversationRequests, summaryRequests: group[0].summaryRequests, pruneEvents: group[0].pruneEvents,
      metadataResults: group[0].metadataResults, metadataReplacements: group[0].metadataReplacements,
      medianWallMs: median(group.map(row => row.wallMs)), medianCpuMs: median(group.map(row => row.cpuMs)), medianRetainedHeapDelta: median(group.map(row => row.retainedHeapDelta)), medianRss: median(group.map(row => row.rss)) })
  }
}
const report = { runtime: process.version, platform: process.platform, arch: process.arch, model: 'scripted; model/network latency excluded; files freshly created before timing, then real filesystem reads or real Bash/Node subprocesses', tokenCounts: 'heuristic, not provider billing', rows, summaries }
await writeFile(join(out, 'real-tools.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(summaries, null, 2) + '\n')
