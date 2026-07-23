import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { TanzuPlugin, PROVIDER_ID, PROVIDER_NAME, secretPath } from "../src/opencode-tanzu.js"
import { TABLE } from "../src/opencode-tanzu-capabilities.js"

// The bundled-fallback roster is every chat entry in the table — derived, not
// hardcoded, so adding a model (Laguna, 2026-07-22) cannot silently break the
// degradation tests.
const FALLBACK_COUNT = Object.values(TABLE).filter((e) => e.kind === "chat").length

const BASE = "https://genai-proxy.example.test/inst/openai/v1"
const SERVER = new URL("http://127.0.0.1:4096")

const ROSTER = {
  data: [
    { id: "cyankiwi/Qwen3.6-27B-AWQ-INT4" },
    { id: "google/gemma-4-31B-it-qat-w4a16-ct" },
    { id: "deepreinforce-ai/Ornith-1.0-35B" },
    { id: "nomic-ai/nomic-embed-text-v2-moe" },
  ],
}

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), "octnz-plugin-test-"))
}

/** Run `fn` with a scratch XDG_DATA_HOME so `secretPath()` lands in a temp dir. */
async function withDataHome(fn) {
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmpdir()
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
  }
}

/** Neither env var set — the config hook must fall back to the key file. */
const NO_ENV = { TANZU_GENAI_BASE_URL: undefined, TANZU_GENAI_API_KEY: undefined }

/** Plant a key file where `secretPath()` will look. Requires `withDataHome`. */
function writeKeyFile(contents) {
  mkdirSync(path.dirname(secretPath()), { recursive: true })
  writeFileSync(secretPath(), contents)
}

/** Run `fn` with the given TANZU_GENAI_* env, restoring afterwards. */
async function withEnv(vars, fn) {
  const previous = {}
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Swap in a stub global fetch (what `discoverModels` uses). */
async function withFetch(impl, fn) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/**
 * A fake PluginInput whose client fetch has the REAL contract: arity 1,
 * Request-only. `createOpencodeClient` injects
 * `(req) => { req.timeout = false; return fetch(req) }` and the SDK types it
 * `fetch?: (request: Request) => ...`. A mock shaped `(url, init)` would hide
 * exactly the bug this file exists to pin.
 */
function fakeInput({ onRequest, saved = {}, logs = [] } = {}) {
  const calls = []
  const clientFetch = (...args) => {
    calls.push(args)
    const req = args[0]
    if (!(req instanceof Request)) {
      // What opencode really does: no init argument exists, so a caller that
      // passed one has just sent a bare GET /global/config — a 200 route.
      return Promise.resolve(jsonResponse({ $schema: "https://opencode.ai/config.json" }))
    }
    if (onRequest) return onRequest(req)
    return Promise.resolve(jsonResponse(saved))
  }
  return {
    calls,
    logs,
    serverUrl: SERVER,
    client: {
      _client: { getConfig: () => ({ fetch: clientFetch, baseUrl: SERVER.href, headers: {} }) },
      app: {
        log: async ({ body }) => {
          logs.push(body)
        },
      },
    },
  }
}

/** A `/global/config` stub that merges the PATCH body, as opencode does. */
function fakeGlobalConfig() {
  const state = { $schema: "https://opencode.ai/config.json" }
  const patches = []
  return {
    state,
    patches,
    onRequest: async (req) => {
      if (req.method !== "PATCH") return jsonResponse(state)
      const body = await req.json()
      patches.push(body)
      for (const [id, stanza] of Object.entries(body.provider ?? {})) {
        state.provider = state.provider ?? {}
        state.provider[id] = { ...state.provider[id], ...stanza }
      }
      return jsonResponse(state)
    },
  }
}

async function hooks(input) {
  return TanzuPlugin(input ?? fakeInput())
}

// ---------------------------------------------------------------------------
// CRITICAL 1 — persistOptions must send a single Request, method PATCH.
// The old code called doFetch(url, {method:"PATCH", ...}); the client's fetch
// takes one argument, so the init was dropped and the wire request was a bare
// GET that 200s and writes nothing.
// ---------------------------------------------------------------------------

test("authorize's config write is a single Request, PATCH, with the provider body", async () => {
  await withDataHome(async () => {
    const server = fakeGlobalConfig()
    const input = fakeInput({ onRequest: server.onRequest })
    const h = await hooks(input)

    const result = await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )
    assert.equal(result.type, "success")

    // Exactly one argument — the client fetch has no `init` parameter at all.
    const configCalls = input.calls.filter((args) => args[0] instanceof Request)
    assert.equal(configCalls.length, 1, "expected exactly one config write")
    assert.equal(configCalls[0].length, 1, "client fetch takes a Request and nothing else")

    const req = configCalls[0][0]
    assert.ok(req instanceof Request, "must be a Request, not (url, init)")
    assert.equal(req.method, "PATCH")
    assert.equal(new URL(req.url).pathname, "/global/config")
    assert.equal(req.headers.get("content-type"), "application/json")

    assert.equal(server.patches.length, 1)
    assert.equal(server.patches[0].provider.tanzu.options.baseURL, BASE)
  })
})

test("authorize fails when the server echoes a config without the write (the GET-shaped 200)", async () => {
  await withDataHome(async () => {
    // A server that 200s with a config that never contains our stanza — exactly
    // what `GET /global/config` returns. res.ok alone would call this a success.
    const input = fakeInput({ saved: { $schema: "https://opencode.ai/config.json" } })
    const h = await hooks(input)

    const result = await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )
    assert.equal(result.type, "failed")
    assert.match(input.logs.at(-1).message, /did not persist/)
  })
})

test("authorize fails loudly when the config write is rejected", async () => {
  await withDataHome(async () => {
    const input = fakeInput({ onRequest: async () => jsonResponse({ error: "nope" }, 500) })
    const h = await hooks(input)
    const result = await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )
    assert.equal(result.type, "failed")
  })
})

test("authorize never writes the config when the foundation rejects the key", async () => {
  await withDataHome(async () => {
    const server = fakeGlobalConfig()
    const input = fakeInput({ onRequest: server.onRequest })
    const h = await hooks(input)
    const result = await withFetch(async () => jsonResponse({}, 401), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "bad" }),
    )
    assert.equal(result.type, "failed")
    assert.equal(server.patches.length, 0)
  })
})

// ---------------------------------------------------------------------------
// CRITICAL 2 — no key reaches the config file, in ANY form.
//
// The config used to carry `"apiKey": "{file:<path>}"`. That was verified to
// brick opencode for EVERY provider if the key file went missing: config
// substitution and validation both complete before any plugin loads, so the
// plugin could not even guard against the state it created, and
// `opencode uninstall --keep-config` walks straight into it. The key is now
// read by the plugin itself in the config hook, and the config names no key.
// ---------------------------------------------------------------------------

test("authorize persists only the baseURL — no apiKey in the config, in any form", async () => {
  await withDataHome(async () => {
    const server = fakeGlobalConfig()
    const input = fakeInput({ onRequest: server.onRequest })
    const h = await hooks(input)

    await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )

    const persisted = server.patches[0].provider.tanzu.options
    assert.deepEqual(persisted, { baseURL: BASE }, "the persisted options are the baseURL and nothing else")
    assert.equal("apiKey" in persisted, false, "no apiKey key at all — neither plaintext nor {file:…}")
    assert.doesNotMatch(JSON.stringify(server.patches), /secret-token/, "the key must not appear in the config write")
    assert.doesNotMatch(JSON.stringify(server.patches), /\{file:/, "the {file:…} indirection must not come back")
    assert.doesNotMatch(JSON.stringify(server.state), /secret-token/, "the key must not appear in the saved config")
  })
})

test("authorize writes the key to a 0600 file under opencode's data dir", async () => {
  await withDataHome(async () => {
    const server = fakeGlobalConfig()
    const h = await hooks(fakeInput({ onRequest: server.onRequest }))

    await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )

    const file = secretPath()
    assert.equal(readFileSync(file, "utf8"), "secret-token")
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(path.dirname(path.dirname(file)), path.join(process.env.XDG_DATA_HOME, "opencode"))
  })
})

// writeFile's `mode` option only applies when it CREATES the file; an
// existing file keeps its old mode. `writeSecret` chmods after writing
// specifically to cover a pre-existing, more permissive file — plant one at
// 0644 first so a regression (deleting the chmod call) would leave it there.
test("authorize tightens a pre-existing, more permissive key file to 0600", async () => {
  await withDataHome(async () => {
    writeKeyFile("stale-key")
    chmodSync(secretPath(), 0o644)
    assert.equal(statSync(secretPath()).mode & 0o777, 0o644, "precondition: file starts out world-readable")

    const server = fakeGlobalConfig()
    const h = await hooks(fakeInput({ onRequest: server.onRequest }))
    await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )

    assert.equal(statSync(secretPath()).mode & 0o777, 0o600, "an existing file's mode must still be tightened")
  })
})

test("authorize still returns the key so it reaches the auth store", async () => {
  await withDataHome(async () => {
    const server = fakeGlobalConfig()
    const h = await hooks(fakeInput({ onRequest: server.onRequest }))
    const result = await withFetch(async () => jsonResponse(ROSTER), () =>
      h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
    )
    assert.deepEqual(result, { type: "success", key: "secret-token", provider: PROVIDER_ID })
  })
})

test("the config hook reads the key file itself and uses it for discovery", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      writeKeyFile("file-sourced-key\n")

      let seenAuth
      const cfg = { provider: { tanzu: { options: { baseURL: BASE } } } }
      const h = await hooks()
      await withFetch(async (url, init) => {
        seenAuth = init.headers.Authorization
        return jsonResponse(ROSTER)
      }, () => h.config(cfg))

      assert.equal(seenAuth, "Bearer file-sourced-key", "the key file is read by the plugin, not by opencode")
      assert.equal(cfg.provider.tanzu.options.apiKey, "file-sourced-key")
      assert.equal(Object.keys(cfg.provider.tanzu.models).length, 3)
    }),
  )
})

test("the whole login round-trip: no key in the config, yet discovery still authenticates", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      const server = fakeGlobalConfig()
      const h = await hooks(fakeInput({ onRequest: server.onRequest }))

      await withFetch(async () => jsonResponse(ROSTER), () =>
        h.auth.methods[0].authorize({ baseURL: BASE, apiKey: "secret-token" }),
      )

      // Exactly what opencode would hand the config hook on the next run: the
      // persisted config, which names no key anywhere.
      const cfg = JSON.parse(JSON.stringify(server.state))
      assert.equal("apiKey" in cfg.provider.tanzu.options, false)

      let seenAuth
      await withFetch(async (url, init) => {
        seenAuth = init.headers.Authorization
        return jsonResponse(ROSTER)
      }, () => h.config(cfg))

      assert.equal(seenAuth, "Bearer secret-token", "the key came from the key file, not the config")
      assert.equal(Object.keys(cfg.provider.tanzu.models).length, 3)
    }),
  )
})

test("an explicit apiKey in the config still wins over the key file", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      // opencode resolves a `{file:…}` in a *committed* config (as
      // foundations/cdc/opencode.json uses) before the hook runs, so what we
      // see here is always a resolved plaintext string.
      writeKeyFile("key-file-key")
      let seenAuth
      const cfg = { provider: { tanzu: { options: { baseURL: BASE, apiKey: "config-key" } } } }
      const h = await hooks()
      await withFetch(async (url, init) => {
        seenAuth = init.headers.Authorization
        return jsonResponse(ROSTER)
      }, () => h.config(cfg))
      assert.equal(seenAuth, "Bearer config-key")
    }),
  )
})

// ---------------------------------------------------------------------------
// IMPORTANT 3 — a models-less stanza must not survive an early return.
// ---------------------------------------------------------------------------

test("an unconfigured stanza is stripped rather than left for opencode to delete silently", async () => {
  await withEnv({ TANZU_GENAI_BASE_URL: undefined, TANZU_GENAI_API_KEY: undefined }, async () => {
    // Exactly what `authorize` leaves on disk: options, no models.
    const cfg = { provider: { tanzu: { options: { somethingElse: true } }, other: { models: {} } } }
    const h = await hooks()
    await h.config(cfg)
    assert.equal("tanzu" in cfg.provider, false)
    assert.equal("other" in cfg.provider, true, "other providers are none of our business")
  })
})

test("a hand-written stanza that already has models is left alone", async () => {
  await withEnv({ TANZU_GENAI_BASE_URL: undefined, TANZU_GENAI_API_KEY: undefined }, async () => {
    const cfg = { provider: { tanzu: { models: { "some/model": { name: "Some model" } } } } }
    const h = await hooks()
    await h.config(cfg)
    assert.deepEqual(Object.keys(cfg.provider.tanzu.models), ["some/model"])
  })
})

test("nothing is contributed when there is no config at all", async () => {
  await withEnv({ TANZU_GENAI_BASE_URL: undefined, TANZU_GENAI_API_KEY: undefined }, async () => {
    const cfg = {}
    const h = await hooks()
    await h.config(cfg)
    assert.deepEqual(cfg, {})
  })
})

// ---------------------------------------------------------------------------
// IMPORTANT 4 — the loader path must actually be reachable.
// ---------------------------------------------------------------------------

test("a baseURL with no key registers the bundled roster so the loader can fire", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      const cfg = { provider: { tanzu: { options: { baseURL: BASE } } } }
      const h = await hooks()
      let discovered = false
      await withFetch(async () => {
        discovered = true
        return jsonResponse(ROSTER)
      }, () => h.config(cfg))

      assert.equal(discovered, false, "discovery cannot authenticate without a key; it must not be attempted")
      assert.equal(Object.keys(cfg.provider.tanzu.models).length, FALLBACK_COUNT)
      assert.equal("apiKey" in cfg.provider.tanzu.options, false, "an empty key must not shadow the loader's")
      assert.equal(cfg.provider.tanzu.name, PROVIDER_NAME)
    }),
  )
})

test("the loader supplies the key from the auth store", async () => {
  const h = await hooks()
  assert.deepEqual(await h.auth.loader(async () => ({ type: "api", key: "from-store" })), { apiKey: "from-store" })
  assert.deepEqual(await h.auth.loader(async () => ({ type: "oauth", access: "x" })), {})
  assert.deepEqual(
    await h.auth.loader(async () => {
      throw new Error("no auth store")
    }),
    {},
  )
})

// A missing key file used to be fatal — and not just for us: opencode refused
// to start for EVERY provider, and no plugin ran, so this could not be handled
// in code at all. Now it is an ordinary degradation.
test("a missing key file degrades gracefully — bundled roster, no throw", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      const cfg = { provider: { tanzu: { options: { baseURL: BASE } } } }
      const h = await hooks()
      await withFetch(
        async () => assert.fail("must not call the foundation without a key"),
        () => h.config(cfg),
      )
      assert.equal("apiKey" in cfg.provider.tanzu.options, false, "an empty key must not shadow the loader's")
      assert.equal(Object.keys(cfg.provider.tanzu.models).length, FALLBACK_COUNT, "never zero models")
      assert.equal(cfg.provider.tanzu.name, PROVIDER_NAME, "the provider is still registered")
    }),
  )
})

test("an unreadable key file degrades the same way rather than throwing", async () => {
  await withEnv(NO_ENV, () =>
    withDataHome(async () => {
      // A directory where the key file should be: readFileSync throws EISDIR.
      mkdirSync(secretPath(), { recursive: true })
      const cfg = { provider: { tanzu: { options: { baseURL: BASE } } } }
      const h = await hooks()
      await withFetch(
        async () => assert.fail("must not call the foundation without a key"),
        () => h.config(cfg),
      )
      assert.equal(Object.keys(cfg.provider.tanzu.models).length, FALLBACK_COUNT)
    }),
  )
})

// ---------------------------------------------------------------------------
// Discovery, env fallback, and the no-zero-model invariant.
// ---------------------------------------------------------------------------

test("config-sourced credentials produce the live roster, embeddings excluded", async () => {
  const cfg = { provider: { tanzu: { options: { baseURL: BASE, apiKey: "k" } } } }
  const h = await hooks()
  await withFetch(async () => jsonResponse(ROSTER), () => h.config(cfg))

  const stanza = cfg.provider.tanzu
  assert.equal(stanza.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(Object.keys(stanza.models), [
    "cyankiwi/Qwen3.6-27B-AWQ-INT4",
    "google/gemma-4-31B-it-qat-w4a16-ct",
    "deepreinforce-ai/Ornith-1.0-35B",
  ])
})

test("env vars remain a working credential source", async () => {
  await withEnv({ TANZU_GENAI_BASE_URL: `${BASE}/`, TANZU_GENAI_API_KEY: "env-key" }, async () => {
    const cfg = {}
    let seenUrl
    const h = await hooks()
    await withFetch(async (url) => {
      seenUrl = url
      return jsonResponse(ROSTER)
    }, () => h.config(cfg))
    assert.equal(seenUrl, `${BASE}/models`, "the trailing slash must be trimmed")
    assert.equal(Object.keys(cfg.provider.tanzu.models).length, 3)
  })
})

test("discovery failure degrades to the bundled table, never to zero models", async () => {
  const cfg = { provider: { tanzu: { options: { baseURL: BASE, apiKey: "k" } } } }
  const h = await hooks()
  await withFetch(async () => jsonResponse({}, 500), () => h.config(cfg))
  assert.equal(Object.keys(cfg.provider.tanzu.models).length, FALLBACK_COUNT)
})

test("an empty roster strips the provider rather than registering zero models", async () => {
  const cfg = { provider: { tanzu: { options: { baseURL: BASE, apiKey: "k" } } } }
  const h = await hooks()
  await withFetch(async () => jsonResponse({ data: [{ id: "nomic-ai/nomic-embed-text-v2-moe" }] }), () => h.config(cfg))
  assert.equal("tanzu" in cfg.provider, false)
})

test("there is no provider.models hook — it can never fire for a novel id", async () => {
  const h = await hooks()
  assert.equal("provider" in h, false)
})

// ---------------------------------------------------------------------------
// Prompt validation must agree with what authorize/trimURL accept.
// ---------------------------------------------------------------------------

test("the URL prompt accepts exactly what the config hook accepts", async () => {
  const h = await hooks()
  const validate = h.auth.methods[0].prompts[0].validate

  assert.equal(validate(BASE), undefined)
  assert.equal(validate(`${BASE}/`), undefined)
  // trimURL strips many trailing slashes, so the prompt must too.
  assert.equal(validate(`${BASE}//`), undefined)
  assert.equal(validate(`  ${BASE}  `), undefined)

  assert.match(validate(""), /required/)
  assert.match(validate("   "), /required/)
  assert.match(validate("not a url"), /valid URL/)
  assert.match(validate("http://proxy.example.test/inst/openai/v1"), /https/)
  assert.match(validate("https://proxy.example.test/inst/v1"), /openai\/v1/)
})

test("the API key prompt rejects whitespace-only input", async () => {
  const h = await hooks()
  const validate = h.auth.methods[0].prompts[1].validate
  assert.equal(validate("a-key"), undefined)
  assert.match(validate(""), /required/)
  assert.match(validate("   "), /required/)
  assert.match(validate(undefined), /required/)
})
