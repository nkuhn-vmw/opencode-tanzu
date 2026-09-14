import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const installer = resolve('install.sh')
test('install, upgrade and uninstall isolate runtimes and preserve unrelated files', () => {
  const home = mkdtempSync(join(tmpdir(), 'tanzu-install-'))
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config') }
  delete env.OPENCODE_TANZU_V2_CONFIG_HOME
  const run = (...args) => spawnSync('bash', [installer, ...args], { env, encoding: 'utf8' })
  try {
    assert.equal(run().status, 0)
    const v1 = join(env.XDG_CONFIG_HOME, 'opencode/plugins/opencode-tanzu.js')
    const v2 = join(env.XDG_CONFIG_HOME, 'opencode-tanzu-v2/opencode/plugins/opencode-tanzu-v2')
    assert.ok(existsSync(v1))
    assert.equal(run('--runtime','v2').status, 0)
    assert.match(readFileSync(join(v2,'index.js'),'utf8'), /opencode-tanzu-v2/)
    writeFileSync(join(v2, 'unrelated.txt'), 'keep')
    assert.equal(run('--runtime','v2').status, 0)
    assert.equal(run('--runtime','v2','--uninstall').status, 0)
    assert.ok(existsSync(v1))
    assert.ok(existsSync(join(v2,'unrelated.txt')))
    assert.ok(!existsSync(join(v2,'index.js')))
    assert.equal(run('--runtime').status, 2)
    assert.equal(run('--runtime','v3').status, 2)
    assert.equal(run('--typo').status, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
