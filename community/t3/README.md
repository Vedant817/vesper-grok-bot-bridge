# Prepare the T3 template

For publishers: create a fresh Bot using [PROFILE.md](PROFILE.md), add the [full T3 role](../../docs/T3_BOT_INSTRUCTIONS.md), and use [LISTING.md](LISTING.md) for its description. Do not duplicate a working Bot containing private account context. Do not assign an initial task, attach the author's endpoint or create routines. Wait for recipient authorization before discovery.

Use the native Share/Create template flow, inspect its actual instructions, memories, skills, routines and integrations, remove private context, then choose visibility and publish only when authorized. Copy the real template link into the release announcement; a source archive is not that link and does not establish marketplace placement.

Recipients add the Bot through Marketplace or the shared link, then follow [T3 setup](../../docs/T3_CONNECT_QUICKSTART.md). They supply their own HTTPS `/mcp` URL and approve T3 OAuth. They do not install this project's CLI/MCP server. Confirm the selected provider's own login and permissions in T3.

Acceptance: list projects/providers read-only; explicitly request one no-edit worktree thread, read its sentinel, continue the exact same thread, read the second sentinel, and stop. The [quickstart](../../docs/T3_CONNECT_QUICKSTART.md) contains the detailed prompt and availability limits. A turn's completion is not proof that coding requirements passed tests.

Read [provider and account boundaries](../../docs/PROVIDER_POLICY.md). T3 orchestration does not exempt underlying providers from their terms.
