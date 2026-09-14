import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import plugin, { connection, refreshInterval, toV2Model, omitUnsupportedPromptCacheKey, applySamplingDefaults } from '../src/opencode-tanzu-v2.js'

const baseURL = 'https://example.test/service/openai/v1'
test('V2 connection validates endpoint and supports rotated token files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tanzu-v2-'))
  try {
    const file = path.join(dir, 'token')
    writeFileSync(file, 'first\n')
    const env = { TANZU_GENAI_BASE_URL: baseURL, TANZU_GENAI_API_KEY_FILE: file }
    assert.equal(connection({}, env).apiKey, 'first')
    writeFileSync(file, 'second')
    assert.equal(connection({}, env).apiKey, 'second')
    assert.equal(connection({ baseURL: baseURL + '/' }, env).baseURL, baseURL)
    for (const url of ['http://example.test/openai/v1', 'https://user:pass@example.test/openai/v1', `${baseURL}?key=x`, `${baseURL}#x`, 'https://example.test/v1']) {
      assert.throws(() => connection({}, { ...env, TANZU_GENAI_BASE_URL: url }))
    }
    assert.equal(connection({}, {}), undefined)
    assert.throws(() => connection({}, { TANZU_GENAI_BASE_URL: baseURL }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('V2 catalog preserves vision, tool verdict, visibility and bounded refresh', () => {
  const m = toV2Model('x', { name: 'X', tool_call: false, modalities: { input: ['text','image'], output: ['text'] }, limit: { context: 8192, output: 4096 } }, 123)
  assert.equal(m.family, 'x')
  assert.deepEqual(m.capabilities, { tools: false, input: ['text', 'image'], output: ['text'] })
  assert.equal(m.time.released, 123)
  assert.equal(refreshInterval(undefined), 300000)
  assert.equal(refreshInterval(1), 30000)
  assert.equal(refreshInterval(9999999), 3600000)
})

test('beta request compatibility only removes generated Tanzu cache keys', async () => {
  const event = () => ({ model: { providerID: 'tanzu', id: 'x' }, sessionID: 'ses_' + 'a'.repeat(64), request: new Request(baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ prompt_cache_key: 'a'.repeat(64), messages: [] }) }) })
  const e = event()
  await omitUnsupportedPromptCacheKey(e)
  assert.equal(Object.hasOwn(await e.request.json(), 'prompt_cache_key'), false)
  const explicit = event()
  await omitUnsupportedPromptCacheKey(explicit, { providers: { tanzu: { body: { prompt_cache_key: 'operator' } } } })
  assert.equal((await explicit.request.json()).prompt_cache_key, 'a'.repeat(64))
  const other = event(); other.model.providerID = 'other'
  await omitUnsupportedPromptCacheKey(other)
  assert.ok((await other.request.json()).prompt_cache_key)
})

test('native setup registers standalone provider, honors operator limits, and scopes credentials', async () => {
  const fetchOriginal = globalThis.fetch
  const env = { ...process.env }
  const data = mkdtempSync(path.join(tmpdir(), 'tanzu-v2-cache-'))
  process.env.XDG_DATA_HOME = data
  process.env.TANZU_GENAI_BASE_URL = baseURL
  process.env.TANZU_GENAI_API_KEY = 'secret-sentinel'
  let transform, hook, cleanup
  let provider
  let result
  const id = 'fixture-chat'
  globalThis.fetch = async (url, init) => {
    assert.equal(init.redirect, 'error')
    if (url.endsWith('/models')) return Response.json({ data: [{ id }] })
    const body = JSON.parse(init.body)
    if (body.max_tokens > 100000) return Response.json({ error: { message: 'max_model_len=32768' } }, { status: 400 })
    return Response.json({ error: { message: 'does not support tools' } }, { status: 400 })
  }
  const catalog = {
    provider: { get: () => undefined, update: (_, fn) => { provider = {}; fn(provider) } },
    model: {
      get: () => ({ limit: { context: 16000, output: 2000 }, body: { temperature: 0.2 } }),
      update: (_, __, fn) => { result = {}; fn(result) },
      default: { get: () => ({ providerID: 'other', modelID: 'keep' }), set: () => assert.fail('overwrote default') },
    },
    transform: async fn => { transform = fn },
    reload: async () => transform(catalog),
  }
  try {
    cleanup = await plugin.setup({ options: {}, catalog, session: { hook: async (_, fn) => { hook = fn } } })
    assert.equal(provider.package, '@opencode/ai/providers/openai-compatible')
    assert.match(provider.settings.baseURL, /^http:\/\/127\.0\.0\.1:/)
    assert.notEqual(provider.settings.apiKey, 'secret-sentinel')
    assert.equal(JSON.stringify(provider).includes('secret-sentinel'), false)
    assert.deepEqual(result.limit, { context: 16000, output: 2000 })
    assert.equal(result.family, id)
    const event = { model: { providerID: 'tanzu', id }, request: new Request(baseURL + '/chat/completions', { method: 'POST', headers: {authorization:'Bearer tanzu-runtime-credential'}, body: '{}' }) }
    await assert.rejects(() => hook(event), /Configure Tanzu connection/)
    assert.notEqual(event.request.headers.get('authorization'), 'Bearer secret-sentinel')
    const foreign = { ...event, request: new Request('https://elsewhere.test/chat/completions', { method: 'POST', body: '{}' }) }
    await assert.rejects(() => hook(foreign), /Configure Tanzu connection/)
    assert.equal(foreign.request.headers.get('authorization'), null)
  } finally {
    cleanup?.(); globalThis.fetch = fetchOriginal
    process.env = env
    rmSync(data, { recursive: true, force: true })
  }
})

test('sampling defaults preserve explicit provider/model and variant body overrides', async () => {
  const event = { request: new Request(baseURL+'/chat/completions',{method:'POST',body:JSON.stringify({temperature:0})}) }
  await applySamplingDefaults(event,{temperature:1,topP:0.95,frequencyPenalty:0.5},{body:{temperature:0},variants:[{id:'unused',body:{top_p:0.8}}]})
  assert.deepEqual(await event.request.json(),{temperature:0,top_p:0.95,frequency_penalty:0.5})
})
