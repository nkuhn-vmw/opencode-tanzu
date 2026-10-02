# Documentation

Start with the native OpenCode V2 path. Plugin 0.5.1 and OpenCode 2.0.18 are the
verified combination; older design notes are historical context.

| Guide | Use it for |
| --- | --- |
| [Project overview](../README.md) | Quick start, adoption prerequisites and architecture. |
| [MacBook getting started](getting-started-mac-tanzu.md) | Install V2, create an AI Models instance/key, configure the plugin and start local development. |
| [V2 operator guide](opencode-v2.md) | Install, desktop/backend scope, migration, token rotation, configuration and troubleshooting. |
| [Model discovery](model-discovery.md) | Served limits, cache behavior and cold-start probe cost. |
| [Validation](validation-standalone-v2.md) | Tested behavior, dates, runtime versions and explicit limits of the evidence. |
| [Security](../SECURITY.md) | Credential handling, endpoint trust and safe reporting. |
| [Contributing](../CONTRIBUTING.md) | Local checks and useful sanitized bug reports. |
| [Changelog](../CHANGELOG.md) | Released changes. |
| [Legacy V1 reference](legacy-v1.md) | Existing V1 installs only. |

The [original standalone design plan](superpowers/plans/2026-09-14-standalone-v2.md)
is historical; current behavior is defined by the operator guide and source.

The README illustration is a deterministic SVG architecture illustration, not
a screenshot or evidence of live deployment. Validation claims link to the
recorded checks; keep versions and dates in sync when refreshing those claims.
