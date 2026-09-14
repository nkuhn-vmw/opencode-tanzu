# Standalone Tanzu V2 implementation plan

**Goal:** Make the existing Tanzu provider usable on local OpenCode V1 and V2/beta, with Homebrew and foundation launcher support.

**Approved design:** Separate runtime entry points sharing the dependency-free discovery, capability and cache modules. Preserve V1 installation by default. Use an explicit V2 install root and native catalog APIs; never load a V1 entry point as a V2 plugin. Credentials stay out of generated configuration. No Cloud Foundry binding is required.

**Implementation:**
- [x] Add `src/opencode-tanzu-v2.js`, adapted from the buildpack, registering its own native provider. Support environment credentials and a rotating token file, conservative served limits, model overrides, refresh cleanup, and the beta prompt-cache compatibility hook. Test these contracts using native-shaped fixtures.
- [x] Extend `install.sh --runtime v1|v2` with isolated installation and exact uninstall ownership. V2 defaults to an isolated XDG config root, reported in instructions. Test install/update/uninstall and unknown arguments.
- [x] Add `octnz --runtime v2` using the standalone plugin and process-scoped environment with foundation URL and token file. Keep V1 config behavior. Test invocation with a fake executable; document launch and refresh behavior.
- [x] Update README, examples, changelog, Homebrew formula and caveats, launcher guides and buildpack documentation links. Pin the Homebrew artifact only after its release checksum exists.
- [x] Run both regression suites, shell/Ruby syntax checks, package contents checks, actual V2 runtime catalog/inference smoke tests, and review final diffs. Record local versus live verification separately.

**Constraints:** Node >=20 for tests; zero plugin runtime dependencies. HTTPS foundation endpoints; TLS verification remains enabled. Never assume lab-specific served limits apply to other installations. Preserve existing operator settings and uncommitted buildpack work.

Validation limits are recorded in `docs/validation-standalone-v2.md`: live discovery passed, live inference timed out, in-app browser blocked loopback. The native client discards redirect policies, so the final adapter uses an authenticated loopback forwarder to keep foundation tokens out of the native client.
