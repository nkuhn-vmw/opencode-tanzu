import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
test('V2 launcher rejects V1 and isolates paths while preserving CLI arguments', () => {
 const root=mkdtempSync(join(tmpdir(),'tanzu-launch-'))
 try {
  const runtime=join(root,'runtime')
  const env={...process.env,OPENCODE_V2_BIN:runtime,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),XDG_STATE_HOME:join(root,'state')}
  for(const k of Object.keys(env)) if(k.startsWith('OPENCODE_TANZU_V2_')) delete env[k]
  writeFileSync(runtime,'#!/bin/bash\nif [[ "$1" == --version ]]; then echo 1.18.31; else exit 99; fi\n',{mode:0o755})
  const rejected=spawnSync('bash',[resolve('bin/opencode-tanzu-v2'),'run','hello'],{env,encoding:'utf8'})
  assert.equal(rejected.status,1)
  assert.match(rejected.stderr,/requires OpenCode V2/)
  writeFileSync(runtime,'#!/usr/bin/env node\nif(process.argv[2]==="--version")console.log("2.0.18");else console.log(JSON.stringify({args:process.argv.slice(2),config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME}))\n',{mode:0o755})
  const accepted=spawnSync('bash',[resolve('bin/opencode-tanzu-v2'),'run','hello world'],{env,encoding:'utf8'})
  assert.equal(accepted.status,0,accepted.stderr)
  const x=JSON.parse(accepted.stdout)
  assert.deepEqual(x.args,['run','hello world'])
  assert.equal(x.config,join(root,'config/opencode-tanzu-v2'))
  assert.equal(x.data,join(root,'data/opencode-tanzu-v2'))
 } finally {rmSync(root,{recursive:true,force:true})}
})
