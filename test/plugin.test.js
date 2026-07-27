import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  TanzuPlugin,
  PROVIDER_ID,
  PROVIDER_NAME,
  secretPath,
  PROBE_ID_CAP,
  PROBE_CONCURRENCY_LIMIT,
  enrichUnknownCards,
} from "../src/opencode-tanzu.js"
import { TABLE, CONSERVATIVE_CONTEXT, resolveModels } from "../src/opencode-tanzu-capabilities.js"
import { cachePath } from "../src/opencode-tanzu-cache.js"

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

/**
 * Rewind every entry in the on-disk discovery cache by `ageMs`, so a test can
 * simulate "a day later" or "40 minutes later" without a real clock or timers.
 * Requires `withDataHome` and a prior `.config()` call that populated the
 * cache file.
 */
function ageCacheEntries(ageMs) {
  const file = cachePath()
  const raw = JSON.parse(readFileSync(file, "utf8"))
  // The cache now also carries a top-level `schemaVersion` number (F5) —
  // skip it, only entries have a `probedAt` to rewind.
  for (const key of Object.keys(raw)) {
    if (key === "schemaVersion") continue
    raw[key].probedAt = Date.now() - ageMs
  }
  writeFileSync(file, JSON.stringify(raw))
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

// ---------------------------------------------------------------------------
// Probing wired into the config hook (Task 5).
// ---------------------------------------------------------------------------

const OVER_LIMIT_400 = {
  error: { message: "max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144." },
}

/**
 * A roster with one id the bundled table has never heard of. A factory, not a
 * shared constant: unlike a real `fetch(...).json()` (which parses a fresh
 * object from the wire every call), this file's `jsonResponse` test helper
 * hands back the literal body object with no cloning — so a single shared
 * object literal would still be aliased across every test that called it,
 * and one test's later mutation of its own `cfg`/roster references could
 * bleed into another's.
 */
function rosterWithUnknown() {
  return { data: [{ id: "cyankiwi/Qwen3.6-27B-AWQ-INT4" }, { id: "acme/brand-new-9b" }] }
}

// REGRESSION (the INT4 -> NVFP4 swap, 2026-07-24): a model id the table does
// not know must get its real context from a probe, not the 8192 default that
// makes opencode compact in a loop.
test("an unknown model is probed and resolves at its served context", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        if (String(url).endsWith("/chat/completions")) {
          const body = JSON.parse(init.body)
          if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
          return jsonResponse({ choices: [{ message: { content: "x" } }] })
        }
        throw new Error(`unexpected url ${url}`)
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 262144)
    }),
  )
})

test("a model already in the table is never probed", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      let probes = 0
      await withFetch(async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER)
        probes += 1
        return jsonResponse(OVER_LIMIT_400, 400)
      }, () => h.config(cfg))
      assert.equal(probes, 0, "table-backed models must not cost a request")
    }),
  )
})

test("an unprobeable model keeps the conservative default and still registers", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        // ollama path: a normal completion, no limit to read.
        return jsonResponse({ choices: [{ message: { content: "hi" } }] })
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 8192)
    }),
  )
})

test("a cached probe result means no second probe on the next start", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      let probes = 0
      const impl = async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        probes += 1
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ message: { content: "x" } }] })
      }
      const first = await hooks()
      await withFetch(impl, () => first.config({}))
      const afterFirst = probes
      assert.ok(afterFirst > 0, "the first start must probe")

      const cfg2 = {}
      const second = await hooks()
      await withFetch(impl, () => second.config(cfg2))
      assert.equal(probes, afterFirst, "the second start must be served from cache")
      assert.equal(cfg2.provider.tanzu.models["acme/brand-new-9b"].limit.context, 262144)
    }),
  )
})

// ---------------------------------------------------------------------------
// C2 — a conclusive result is pinned for the full week; an inconclusive one
// is retried once its much shorter TTL elapses. Caching the two alike was
// the finding: it let one unlucky startup (VPN reconnecting, a tile worker
// restarting) pin a brand-new model at the 8192 default for seven days, with
// no way to recover short of clearing the cache by hand.
// ---------------------------------------------------------------------------

test("a conclusively clamped context probe is cached long-term and is not re-probed a day later", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      let probes = 0
      const impl = async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        probes += 1
        // A normal 200 completion to both the context probe (max_tokens
        // 999999999) and the tool-call probe: the backend clamped instead of
        // erroring and cleanly declined the forced tool call. Both outcomes
        // are conclusive, permanent answers — never conflate this with a
        // transient failure.
        return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] })
      }
      const first = await hooks()
      await withFetch(impl, () => first.config({}))
      const afterFirst = probes
      assert.ok(afterFirst > 0, "the first start must probe")

      // Simulate a day passing: long past the 30-minute inconclusive TTL,
      // comfortably inside the 7-day conclusive TTL.
      ageCacheEntries(24 * 60 * 60 * 1000)

      const cfg2 = {}
      const second = await hooks()
      await withFetch(impl, () => second.config(cfg2))
      assert.equal(probes, afterFirst, "a conclusively clamped result must not be re-probed within the week")
      assert.equal(
        cfg2.provider.tanzu.models["acme/brand-new-9b"].limit.context,
        8192,
        "clamped means unprobeable, not that a numeric value is known — the conservative default stands",
      )
    }),
  )
})

test("an inconclusive probe is not pinned long-term — it is retried once its short TTL elapses", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      let probes = 0
      const impl = async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        probes += 1
        // A transient failure on every probe request — the tile worker
        // mid-restart. Inconclusive: it says nothing permanent about this
        // model, and must not be cached as though it did.
        return jsonResponse({ error: { message: "Service Unavailable" } }, 503)
      }
      const first = await hooks()
      await withFetch(impl, () => first.config({}))
      const afterFirst = probes
      assert.ok(afterFirst > 0, "the first start must probe")

      // Past the 30-minute inconclusive TTL — this is the crux: a cache that
      // (wrongly) applied the 7-day TTL uniformly would still call this a hit,
      // recreating the original compaction-loop incident.
      ageCacheEntries(40 * 60 * 1000)

      const cfg2 = {}
      const second = await hooks()
      await withFetch(impl, () => second.config(cfg2))
      assert.ok(probes > afterFirst, "an inconclusive result must be retried once its short TTL elapses")
    }),
  )
})

test("the provider still registers with a non-empty model list when every probe is inconclusive", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        // Every probe request fails outright — DNS/TLS/timeout style.
        throw new Error("ECONNREFUSED")
      }, () => h.config(cfg))

      assert.ok(Object.keys(cfg.provider.tanzu.models).length > 0, "the picker must never end up empty")
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 8192)
    }),
  )
})

// ---------------------------------------------------------------------------
// IMPORTANT — cross-id probe concurrency. Every fixture above has exactly one
// unknown id, so a regression from Promise.all fan-out (over ids) to a serial
// `for` loop would pass every test above unnoticed. This one uses TWO unknown
// ids and tracks, via a Set keyed by model id, how many DISTINCT ids have a
// probe in flight at once. A same-id pair of probes (context + tool_call)
// cannot push that count past 1 by itself — the Set dedupes the id — so the
// count only exceeds 1 when two different ids are genuinely in flight
// together, which is exactly what a serial per-id loop would never allow.
// ---------------------------------------------------------------------------

test("probes for different unknown ids run concurrently, not serially", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()

      const inFlightIds = new Set()
      let maxConcurrentIds = 0

      await withFetch(async (url, init) => {
        if (String(url).endsWith("/models")) {
          return jsonResponse({ data: [{ id: "acme/brand-new-9b" }, { id: "acme/second-9b" }] })
        }
        const body = JSON.parse(init.body)
        const id = body.model
        inFlightIds.add(id)
        maxConcurrentIds = Math.max(maxConcurrentIds, inFlightIds.size)
        // Yield a tick before resolving so overlapping in-flight probes have a
        // chance to accumulate in the Set before any of them clear out of it.
        // No sleep/timer involved — this is a single microtask tick, and the
        // synchronous portion of Promise.all's fan-out (every callback runs up
        // to its first await before the event loop drains any microtask) is
        // what actually produces the overlap, not this delay.
        await Promise.resolve()
        inFlightIds.delete(id)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ message: { content: "x" } }] })
      }, () => h.config(cfg))

      assert.ok(
        maxConcurrentIds > 1,
        `expected probes for different ids to overlap in flight, but max concurrent distinct ids was ${maxConcurrentIds}`,
      )
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 262144)
      assert.equal(cfg.provider.tanzu.models["acme/second-9b"].limit.context, 262144)
    }),
  )
})

// ---------------------------------------------------------------------------
// Finding 2 (Wave 4) — PROBE_PHASE_BUDGET_MS/deadlineAt had zero coverage.
// `enrichUnknownCards` takes an optional `budgetMs` override (defaulting to
// the real 40s constant) purely so this test can exercise the deadline
// without a real 40-second wait. It proves BOTH halves of the contract: new
// probes stop starting once the budget elapses (bounded by
// PROBE_CONCURRENCY_LIMIT, not the full roster), AND every card — probed or
// not — still comes back, so `resolveModels` still registers a model for
// each one (unprobed ids simply keep the conservative default).
//
// This must fail if the `{ deadlineAt }` wiring into `mapWithConcurrency` (or
// the guard inside it) is ever removed: with no deadline enforced, a worker
// pool just keeps picking up items until the roster is exhausted, so ALL
// ids would end up probed regardless of how tiny `budgetMs` is.
// ---------------------------------------------------------------------------

test("enrichUnknownCards stops starting new probes once its budget elapses, but still returns every card", async () => {
  await withDataHome(async () => {
    const totalUnknown = PROBE_CONCURRENCY_LIMIT + 4
    const cards = Array.from({ length: totalUnknown }, (_, i) => ({ id: `acme/budget-${i}` }))

    const probedIds = new Set()
    const impl = async (url, init) => {
      const body = JSON.parse(init.body)
      probedIds.add(body.model)
      // Slow enough that the tiny budget below expires before a worker loops
      // back for a second item, but no test relies on wall-clock precision
      // beyond "some delay, then respond".
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
      return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "x" } }] })
    }

    const { cards: enriched } = await withFetch(impl, () =>
      // budgetMs=1: expired before any worker's second iteration, so only the
      // first PROBE_CONCURRENCY_LIMIT ids picked up synchronously get probed.
      enrichUnknownCards(cards, BASE, "k", 1),
    )

    assert.equal(
      probedIds.size,
      PROBE_CONCURRENCY_LIMIT,
      `expected only the first ${PROBE_CONCURRENCY_LIMIT} (concurrency-bounded) ids to be probed before the budget elapsed`,
    )

    // Every card — probed or not — must still come back, so the provider
    // still registers a model for each one.
    assert.equal(enriched.length, totalUnknown, "no card may be dropped just because its probe never started")
    const models = resolveModels(enriched)
    assert.equal(Object.keys(models).length, totalUnknown, "the provider must still register every model")

    // The ids abandoned to the deadline never got a max_model_len, so they
    // keep the conservative default rather than a fabricated number.
    for (const id of Object.keys(models)) {
      if (!probedIds.has(id)) {
        assert.equal(models[id].limit.context, CONSERVATIVE_CONTEXT, `${id} was never probed and must keep the default`)
      }
    }
  })
})

test("a probed tool_call:false overrides the optimistic default", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(rosterWithUnknown())
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "no tools here" } }] })
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].tool_call, false)
    }),
  )
})

// ---------------------------------------------------------------------------
// I2 — unbounded probe fan-out. A roster with more unknown ids than
// PROBE_ID_CAP must probe only the first PROBE_ID_CAP of them and skip the
// rest (falling back to the conservative default), logging one clear line
// about the skip rather than silently firing hundreds of concurrent
// generation requests at a cold start.
// ---------------------------------------------------------------------------

test("a roster with more unknown ids than the cap probes only the cap and skips the rest with a logged message", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()

      const totalUnknown = PROBE_ID_CAP + 10
      const unknownCards = Array.from({ length: totalUnknown }, (_, i) => ({ id: `acme/model-${i}` }))

      const probedIds = new Set()
      const errors = []
      const realError = console.error
      console.error = (msg) => errors.push(String(msg))
      try {
        await withFetch(async (url, init) => {
          if (String(url).endsWith("/models")) return jsonResponse({ data: unknownCards })
          const body = JSON.parse(init.body)
          probedIds.add(body.model)
          if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
          return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "x" } }] })
        }, () => h.config(cfg))
      } finally {
        console.error = realError
      }

      assert.equal(probedIds.size, PROBE_ID_CAP, `expected exactly ${PROBE_ID_CAP} distinct ids to be probed`)
      assert.ok(
        errors.some((m) => m.includes(`${totalUnknown}`) && m.includes(`${PROBE_ID_CAP}`) && m.includes("10")),
        `expected a skip message naming the roster size, the cap, and the skipped count; got: ${JSON.stringify(errors)}`,
      )

      // Probed ids (the first PROBE_ID_CAP, in roster order) get the served context.
      assert.equal(cfg.provider.tanzu.models["acme/model-0"].limit.context, 262144)
      // Ids beyond the cap were never probed and fall back to the conservative default.
      assert.equal(cfg.provider.tanzu.models[`acme/model-${PROBE_ID_CAP}`].limit.context, CONSERVATIVE_CONTEXT)
    }),
  )
})

// ---------------------------------------------------------------------------
// F1 — the cap must be applied AFTER the cache lookup, not before. Pre-fix,
// enrichUnknownCards sliced the raw unknown-id list to PROBE_ID_CAP and only
// then read the cache, so already-cached ids kept consuming cap slots on
// every subsequent run and the tail beyond the cap was never reached on ANY
// start. This test runs the config hook TWICE against the SAME on-disk cache
// (shared XDG_DATA_HOME) over PROBE_ID_CAP + N unknown ids and asserts the
// second run reaches the ids the first run had to skip. It must fail against
// the pre-fix ordering (cap-then-cache).
// ---------------------------------------------------------------------------

test("a second start probes the tail the first start's cap skipped, once the head is cached", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const totalUnknown = PROBE_ID_CAP + 3
      const unknownCards = Array.from({ length: totalUnknown }, (_, i) => ({ id: `acme/model-${i}` }))
      const impl = async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse({ data: unknownCards })
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "x" } }] })
      }

      // Run 1: probes only the first PROBE_ID_CAP ids (0..24); the tail
      // (25..27) is skipped and falls back to the conservative default.
      const first = await hooks()
      const cfg1 = {}
      await withFetch(impl, () => first.config(cfg1))
      assert.equal(cfg1.provider.tanzu.models["acme/model-0"].limit.context, 262144)
      for (let i = PROBE_ID_CAP; i < totalUnknown; i++) {
        assert.equal(
          cfg1.provider.tanzu.models[`acme/model-${i}`].limit.context,
          CONSERVATIVE_CONTEXT,
          `run 1: id ${i} (past the cap) must not have been probed yet`,
        )
      }

      // Run 2, same cache on disk: the first PROBE_ID_CAP ids are now cached
      // hits and must not consume any cap slots, so the previously-skipped
      // tail gets probed this time.
      const probedOnSecondRun = new Set()
      const impl2 = async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse({ data: unknownCards })
        probedOnSecondRun.add(JSON.parse(init.body).model)
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "x" } }] })
      }
      const second = await hooks()
      const cfg2 = {}
      await withFetch(impl2, () => second.config(cfg2))

      for (let i = PROBE_ID_CAP; i < totalUnknown; i++) {
        assert.ok(
          probedOnSecondRun.has(`acme/model-${i}`),
          `run 2: id ${i} (skipped by run 1's cap) must be probed once the cache no longer holds cap slots hostage`,
        )
        assert.equal(
          cfg2.provider.tanzu.models[`acme/model-${i}`].limit.context,
          262144,
          `run 2: previously-skipped id ${i} must now resolve at its served context`,
        )
      }
    }),
  )
})
