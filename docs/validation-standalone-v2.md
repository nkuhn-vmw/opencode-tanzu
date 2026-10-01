# OpenCode V2 validation

## 0.5.1 — background service and project scopes

Removed the process-wide setup guard so each project location can register its
provider and model hooks. Confirmed duplicate
native plugin entries in a real OpenCode 2.0.18 standalone process complete an
inference without conflicting hooks; an isolated setup counter recorded exactly
one setup for two entries with the same plugin ID. Unit coverage also checks separate setup
contexts register independently. A Mac background-service migration also exposed
legacy credential metadata overriding the native transport; the migration guide
now describes backing up and removing that connection.

- 154 Node checks pass, including separate context transports and cleanup.
- Real Mac background-service sessions in home and buildpack project scopes each
  completed inference. New DeepSeek and Qwen shell `printf` calls completed and
  returned their markers.
- A migrated legacy credential with a remote URL was blocked by the native
  origin check. Its exact backed-up Tanzu record was removed via
  `credential.remove`; the private token file and other credentials were retained.
- No model or AI Server configuration was changed.
- Independent bounded review: Claude Opus 5.5 (`claude-opus-5-5`). Findings about
  context fixtures and evidence wording were addressed before release.


## 0.5.0 / OpenCode 2.0.18 — 2026-10-01

- 154 existing/focused Node checks pass, including token rotation, redirect
  rejection, native API registration, override precedence,
  refresh composition, installer isolation and V1 runtime rejection.
- A real isolated 2.0.18 process returned a fixed completion through the
  authenticated token-file transport. Scoped request metadata confirmed
  DeepSeek temperature 1, top_p 0.95 and frequency_penalty 0.5.
- Provider top_p 0.8, model frequency_penalty 0.4 and selected-variant
  temperature 0.2 reached the real request. Explicit zero model/variant values
  also reached the request. A shell `printf` completed and returned its marker.
- A model configured with only a body retained the discovered context 262144,
  output 32768 and text/tool capabilities, rather than native generic defaults.
- Independent read-only review: Claude Opus 5.5 (`claude-opus-5-5`).

This validates the local native integration and short tool flow. It does not
prove every model is reliable in long sessions, force a changing discovery
source on refresh, or substitute for CF buildpack deployment validation.

## Historical validation

# Standalone V2 validation — 2026-09-14

## Verified locally

- OpenCode V2 **2.0.3**, macOS arm64: installed plugin activation, native model
  catalog and streaming inference through an authenticated HTTPS fixture.
- OpenCode beta **0.0.0-beta-19425**, macOS arm64: the same fixture inference
  path, using separate state and automatic plugin-directory discovery.
- Both returned `TANZU_STANDALONE_OK` through the loopback forwarder.
- A real V2 2.0.3 request to a fixture returning HTTP 307 failed with 502;
  the redirect target received no requests or foundation credential.
- Node regression suites cover V1 behavior, V2 credentials, model metadata,
  token-file rotation, request compatibility, sampling overrides, transport
  authentication/streaming/redirect rejection, and installer isolation.
- Launcher fixtures verify V2 argument forwarding, foundation URL and token
  pathname handling without exporting the token or loading the V1 config.
- ShellCheck and Homebrew formula style validation passed.

## Live foundation result and limits

An existing authorized Tanzu endpoint returned HTTP 200 and a live chat-model
roster. Three minimal OpenCode inference attempts, using GPT-OSS 20B and Gemma
E4B, exceeded the 120-second test timeout. **Live end-to-end inference was not
proven.** The successful fixture tests establish native runtime/adapter/stream
compatibility, not live model quality, latency or tool execution.

The Codex in-app browser rejected the authenticated loopback test page with
`ERR_BLOCKED_BY_CLIENT`. **Rendered browser interaction was not verified.**
No Chrome automation was used. No CF application, service, binding or service
key was created, changed or deleted during validation.

Other operating systems, architectures, beta snapshots and desktop embedded
backends were not exercised. Revalidate those targets before asserting support.
