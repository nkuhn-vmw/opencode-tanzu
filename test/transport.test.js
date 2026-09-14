import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTransport } from '../src/opencode-tanzu-transport.js'
test('transport authenticates locally, rotates upstream key, streams and rejects redirects', async () => {
  let key = 'first', mode = 'ok', calls = 0
  const transport = await createTransport(() => ({ baseURL: 'https://example.test/openai/v1', apiKey: key }), async (url, init) => {
    calls++
    assert.equal(url,'https://example.test/openai/v1/chat/completions')
    assert.equal(init.redirect,'error')
    assert.equal(init.headers.get('x-tenant'), 'operator-value')
    assert.equal(init.headers.get('authorization'),'Bearer '+key)
    if(mode==='redirect') return new Response(null,{status:307,headers:{location:'https://elsewhere.test'}})
    return new Response('data: test\n\n',{headers:{'content-type':'text/event-stream'}})
  })
  const post=(suffix='',auth=transport.apiKey)=>fetch(transport.baseURL+'/chat/completions'+suffix,{method:'POST',headers:{authorization:'Bearer '+auth,'x-tenant':'operator-value'},body:'{}'})
  try {
    assert.equal((await post('','wrong')).status,401)
    assert.equal((await post('/other')).status,404)
    assert.equal(calls,0)
    assert.equal(await (await post()).text(),'data: test\n\n')
    key='rotated'
    assert.equal((await post()).status,200)
    mode='redirect'
    const response=await post()
    assert.equal(response.status,502)
    assert.equal(response.headers.get('location'),null)
    assert.ok(!(await response.text()).includes('rotated'))
  } finally { transport.close() }
})
