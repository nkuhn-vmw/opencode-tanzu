# Security and trust boundaries

This is a community provider plugin, not a security boundary for the entire
OpenCode agent. Review your model endpoint, tool permissions, MCP integrations
and host access before use. Prompts and tool results go to the selected model
endpoint; the plugin does not prevent other agent tools from making network
requests.

## Credentials and transport

- Keep service-key tokens outside projects and committed config. Use a token
  file readable only by its owner (0600) in a private directory (0700).
- The native V2 catalog receives an ephemeral local credential, not the
  foundation key. An authenticated loopback forwarder reads the foundation key
  per request and streams chat requests to the configured endpoint.
- Discovery, probes and upstream chat requests reject redirects. The forwarder
  permits chat-completion POSTs and caps request bodies at 32 MiB.
- Use HTTPS for the foundation endpoint. For private certificate authorities,
  set `NODE_EXTRA_CA_CERTS` to an approved CA bundle; never disable TLS checks.
- Environment credentials are supported, but process environments and diagnostic
  dumps can expose them. Prefer the private token-file path.
- The plugin does not provision, revoke or rotate service keys. Follow your
  platform operator's procedure, then update the token file privately.

The loopback credential protects the local forwarding endpoint; it does not
replace authentication for an OpenCode web/API server. Configure application
authentication before exposing a backend beyond loopback.

## Migration and debugging

Back up existing state before removing a conflicting legacy Tanzu connection.
Remove only the relevant connection metadata, preserving other credentials and
session history. Finish or pause active work before shared-service restarts.

Do not publish service-key documents, headers, environment dumps, token-file
contents or session prompt bodies. Capture only the fields needed for the
investigation, such as runtime version, sampling values, finish reason and tool
status. Sanitize endpoint hostnames, usernames and project paths as appropriate.

## Reporting

For a suspected vulnerability, use GitHub's private vulnerability reporting if
available on this repository; otherwise contact the maintainer privately before
posting sensitive details. Public issues should contain sanitized reproduction
steps only. There is no vendor support commitment or response-time SLA.
