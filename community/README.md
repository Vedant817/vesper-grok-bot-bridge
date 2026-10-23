# Grok Bot templates: publisher sources

Community members add a Bot from Grok Bot Marketplace or a genuine shared template link. They do not install a template with npm or need this source-kit archive. Marketplace placement and a public share link are separate from building files locally. No published link is configured in this repository yet.

Maintain **two focused templates**:

| Template | Profile and listing | Full role | Required MCP connection |
| --- | --- | --- | --- |
| Vesper — T3 | [T3 profile](t3/PROFILE.md), [listing](t3/LISTING.md) | [T3 instructions](../docs/T3_BOT_INSTRUCTIONS.md) | Recipient's T3 Connect HTTPS `/mcp`; T3 provides the server. |
| Vesper — CLI | [CLI profile](cli/PROFILE.md), [listing](cli/LISTING.md) | [CLI instructions](../docs/GROK_BOT_INSTRUCTIONS.md) | Recipient's installed bridge HTTPS/OAuth `/mcp`; this project provides the server. |

Use [T3 preparation](t3/README.md) or [CLI preparation](cli/README.md). Keep credentials, personal connectors, internal URLs, paths, skills, routines and account context out of both exports. Inspect the platform's actual template details before publication. A fresh Bot is not a security boundary: account-shared tools may still be visible.

Two templates prevent confusing `t3_*` thread operations with the bridge's `agent_*` session and verification tools. A combined Bot is possible for an advanced owner who connects both, but is not the default community template. Require an explicit route, discover the selected tool schemas, keep IDs separate and never silently fall back to another backend. See [route details](../docs/ROUTES.md).

The [official sharing flow](https://docs.x.ai/grok-bot/bots#share-a-bot) creates the link inside Grok Bot. The [official template guide](https://x.ai/bot/guides/templates-for-grok-bot) explains that custom MCP server code is not bundled with a template. Each recipient authorizes their own connection and native provider accounts.

The [community overview](overview/README.md) holds the Excalidraw diagrams for introducing this project: the cloud-to-local bridge, the two routes, and the supervision loop. Those images are project documentation, not a social-network export.

`npm run pack:community` builds the **publisher source kit** containing both template definitions, plus the standalone CLI/MCP runtime and checksums. It does not publish a Bot, install a connector, share accounts or create a marketplace listing. Follow [distribution](../docs/DISTRIBUTION.md) and [provider policy review](../docs/PROVIDER_POLICY.md) before release.
