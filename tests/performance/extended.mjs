/**
 * Reproduce the real-tool and default-budget-crossing reports after `pnpm build`:
 * `node tests/performance/extended.mjs`.
 * `--smoke` compiles the same plain-Node driver and executes one synthetic step
 * without overwriting the measured reports. Requests use a scripted model.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../../', import.meta.url))
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('usage: node tests/performance/extended.mjs [--smoke]')

function run(args, timeout) {
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout })
  if (child.error || child.signal || child.status !== 0) throw new Error(`extended diagnostic failed: ${child.error?.message ?? child.signal ?? child.stderr}`)
  process.stdout.write(child.stdout)
  return child.stdout
}

if (process.argv.includes('--smoke')) {
  const out = join(root, '.artifacts/performance')
  await mkdir(out, { recursive: true })
  await build({ entry: [join(root, 'tests/performance/context-budget.perf.ts')], outDir: out, format: 'esm', platform: 'node', dts: false, clean: false, config: false })
  const row = JSON.parse(run(['--expose-gc', join(out, 'context-budget.perf.mjs'), 'budgeted', '1', '--prefix'], 30000))
  if (row.conversationRequests !== 2 || row.steps !== 1 || 'productRoot' in row) throw new Error('unexpected smoke workload or absolute-path field')
  await writeFile(join(out, 'extended-smoke.json'), JSON.stringify(row, null, 2) + '\n')
} else {
  run([join(root, 'tests/performance/real-tools.mjs')], 180000)
  run([join(root, 'tests/performance/long-session.mjs')], 60000)
}
