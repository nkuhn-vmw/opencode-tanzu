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
roster. Two minimal OpenCode inference attempts, using GPT-OSS 20B and Gemma
E4B, exceeded the 120-second test timeout. **Live end-to-end inference was not
proven.** The successful fixture tests establish native runtime/adapter/stream
compatibility, not live model quality, latency or tool execution.

The Codex in-app browser rejected the authenticated loopback test page with
`ERR_BLOCKED_BY_CLIENT`. **Rendered browser interaction was not verified.**
No Chrome automation was used. No CF application, service, binding or service
key was created, changed or deleted during validation.

Other operating systems, architectures, beta snapshots and desktop embedded
backends were not exercised. Revalidate those targets before asserting support.
