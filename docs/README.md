# Documentation

## Users

- [Choose T3 or standalone CLI supervision](ROUTES.md): two focused Bot templates and their different MCP connections.
- [T3 setup](T3_CONNECT_QUICKSTART.md): existing T3 MCP, native OAuth, no bridge install.
- [Standalone MCP setup](STANDALONE.md): install once, enroll repository/CLI, HTTPS gateway and OAuth.
- [CLI/provider enrollment and live evidence](CLI_CONNECTIONS.md).
- [Provider policy and account risks](PROVIDER_POLICY.md): authentication, subscriptions, hosted use, quotas and human-only steps.
- [Remote access and network safety](NETWORK_SECURITY.md): T3 Connect vs Tailscale Serve/Funnel, public exposure, ACLs and rollback.
- [Persistent bridge administration](BRIDGE.md) and [monitoring/recovery](SUPERVISION.md).

## Publishers and contributors

- [Two Bot template sources](../community/README.md): profiles, roles, listing copy and publishing boundaries.
- [Build and distribute](DISTRIBUTION.md): CLI archive, publisher source kit, hashes and release checklist.
- [Contributor guide and directory map](../CONTRIBUTING.md).
- [Architecture](ARCHITECTURE.md), [protocol contracts](PROTOCOLS.md), [verification history and limits](VERIFICATION.md).
- [Legacy API-key supervisor](LEGACY_SUPERVISOR.md): optional advanced mode, separate from the Grok Bot templates.
- [Mesh research](research/MESH.md): optional future transport assessment, not a dependency.
- [CLIProxyAPI assessment](research/CLIPROXYAPI.md): why account pooling, quota failover and client cloaking are not integrated.
