# Choose a supervision route

The recommended community offering has **two Bot templates and two MCP connection routes**, with **one MCP server implemented by this repository**.

| | Vesper — T3 | Vesper — CLI |
| --- | --- | --- |
| Recipient gets the Bot | Grok Bot Marketplace or published template link | Grok Bot Marketplace or published template link |
| Coding backend | T3 Code projects/threads | Background native CLI processes, usually ACP v1 stdio |
| MCP server | Already supplied by T3 | `grok-bot-mcp-agent`, installed on the coding host |
| Connection | T3 Connect HTTPS `/mcp` + T3 OAuth | Owner-controlled HTTPS `/mcp` + bridge OAuth |
| Remote exposure | T3 Connect relay; no inbound bridge port | Owner-controlled HTTPS tunnel or Tailscale Funnel; Serve only for tailnet devices |
| Main tool family | `t3_*` plus T3 capabilities | `agent_*` |
| New work | Explicit T3 project/model and isolated worktree thread | Owner-enrolled Git repository/provider/model and isolated session |
| Continuation | Exact T3 thread/run IDs | Exact bridge/native session IDs; native load support where needed |
| Verification | Available T3 evidence and the worker's actual project checks | Immutable owner verifier, change evidence and current `agent_finish` gate |
| Required local software | T3 and its configured providers | Node.js 22+, npm, Git, this bridge and selected CLI/ACP adapter |
| Setup | [T3 guide](T3_CONNECT_QUICKSTART.md) | [Standalone guide](STANDALONE.md), [CLI enrollment](CLI_CONNECTIONS.md) |
| Publisher source | [T3 template](../community/t3/README.md) | [CLI template](../community/cli/README.md) |

The two `/mcp` URLs are different resources with different credentials. Approving one does not authorize the other. Neither requires an xAI API key when the installed Grok Bot supplies reasoning. The optional [legacy supervisor](LEGACY_SUPERVISOR.md) does require an API key and is a separate mode.

Tailscale is an optional transport, not a third route. T3 Connect remains the preferred remote path for T3; a private Tailscale `Serve` address is not generally reachable from Grok Bot's cloud, and a public `Funnel` address still requires the bridge's OAuth. See [remote access and network safety](NETWORK_SECURITY.md).

## Combined template

An advanced user can connect both resources to one Bot, but each task must name its route. Discover the chosen server's schemas, retain IDs with their backend, and never treat an unavailable backend as permission to launch elsewhere. Do not send `agent_*` arguments to `t3_*` tools, assume matching permission ceilings or claim the bridge's verification gate on native T3 operations. No combined marketplace template or automatic cross-backend fallback is shipped.

## Marketplace and distribution

An ordinary user adds a Bot through the platform; the `.tgz` source kit is for publishers/contributors or manual setup, not a marketplace requirement. Native publication generates the Add-to-Grok-Bot link. A public link does not prove catalog inclusion. The published template links are listed in the [repository README](../README.md#choose-your-setup). See [publisher instructions](../community/README.md).

Only the CLI route needs the runtime archive. One installed bridge can operate multiple owner-enrolled CLIs; there is no separate MCP server installation per model/vendor. Other local MCP clients can use its stdio `connect` command instead of remote HTTPS. Read [provider policy](PROVIDER_POLICY.md): ACP support is a protocol capability, not permission to proxy subscriptions or bypass restrictions.
