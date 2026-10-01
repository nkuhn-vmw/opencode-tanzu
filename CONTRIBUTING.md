# Contributing

Keep changes focused on native OpenCode V2 and preserve generic endpoint use.
The V1 adapter remains for compatibility; new examples should use V2.

## Local checks

```bash
npm test
```

Node 20+ is needed for tests. There are no dependencies to install or plugin
artifacts to build. For installer or runtime changes, exercise an isolated
installation and a real V2 inference in addition to focused regression tests.
A model listing proves discovery, not inference or tool execution.

For documentation changes, check links, code examples and rendered README
layout. Keep current instructions separate from historical validation.

## Useful bug reports

Include:

- Plugin version, OpenCode version, OS/architecture and install method.
- Whether the client uses the wrapper, a project plugin or a desktop backend.
- Sanitized model ID, failure time/timezone and whether a fresh short session reproduces it.
- Actual tool status and finish reason, plus the smallest safe reproduction.
- Relevant sanitized error text and numeric sampling settings when needed.

Never attach tokens, service keys, authorization headers, environment dumps,
private endpoint URLs or full session histories. Preserve private originals
locally if they are needed for investigation. Do not enable broad tracing as a
default reproduction step.

Describe what changed and what was actually tested in each pull request. Update
operator instructions when changing installation, credential handling or native
configuration behavior. Use the [validation record](docs/validation-standalone-v2.md)
for dated evidence and its limitations.
