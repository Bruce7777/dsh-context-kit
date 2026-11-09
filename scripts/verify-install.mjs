/** Install, mount and remove a package in an isolated shipped DSH profile. */
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const supplied = process.argv[2]
if (!supplied || process.argv.length !== 3) {
  throw new Error('Usage: pnpm run verify:install <local .tgz path or public archive URL>')
}
const spec = /^https?:\/\//u.test(supplied) ? supplied : resolve(supplied)
const runFile = promisify(execFile)
const require = createRequire(import.meta.url)
const bin = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-context-install-'))
const env = { ...process.env, DSH_HOME: join(root, 'home'), DEEPSEEK_API_KEY: 'install-smoke-key', DSH_TELEMETRY_DISABLED: '1' }

async function dsh(args) {
  try {
    const { stdout } = await runFile(process.execPath, [bin, ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
}

function entry(config, id) {
  const text = config.split(/(?=^- id: )/mu).find(row => row.startsWith(`- id: ${id}\n`))
  assert.ok(text, `Missing profile entry ${id}`)
  return text
}

try {
  await dsh(['plugin', '--profile', 'headless', 'add', spec])
  const profile = JSON.parse(await readFile(join(env.DSH_HOME, 'profiles/headless/package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('dsh-context-kit'), 'Bundle not selected')
  const config = await dsh(['--profile', 'headless', '--dump-config'])
  for (const [id, name] of [['context-budget', 'budgeted'], ['context-recall', 'recall']]) {
    const row = entry(config, id)
    assert.ok(row.includes(`dsh-context-kit/${name}`), `Wrong module for ${id}`)
    assert.doesNotMatch(row, /disabled: true/u)
  }
  assert.match(entry(config, 'compaction-basic'), /disabled: true/u)
  const help = await dsh(['--profile', 'headless', '--help'])
  assert.match(help, /Usage: dsh --profile headless/u)
  await dsh(['plugin', '--profile', 'headless', 'remove', 'dsh-context-kit'])
  const restored = await dsh(['--profile', 'headless', '--dump-config'])
  assert.doesNotMatch(restored, /dsh-context-kit/u)
  assert.doesNotMatch(entry(restored, 'compaction-basic'), /disabled: true/u)
  console.log(JSON.stringify({ source: /^https?:\/\//u.test(spec) ? 'public-url' : 'local-archive', install: 'passed', composition: 'passed', startup: 'passed', removeAndRestore: 'passed', isolatedHome: true }))
} finally {
  await rm(root, { recursive: true, force: true })
}
