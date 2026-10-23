# Coding Agent Supervisor template

This is the source kit for a shareable Grok Bot, paired with the separately installed `grok-bot-mcp-agent` CLI/MCP runtime. It is not a native import file or an approved marketplace listing. Extract the kit; do not run `npm install` in it.

## Prepare the Bot

1. Create a fresh Bot in Grok Bot. Use [PROFILE.md](PROFILE.md) for its name and description. Do not duplicate a Bot containing private memories, company skills, routines or accounts.
2. Give it the [supervisor instructions](../docs/GROK_BOT_INSTRUCTIONS.md). The optional [creation prompt](CREATE_BOT_PROMPT.md) describes the same clean draft. Confirm the instructions were retained in its profile or an included skill; a chat message alone is not proof that a shared template contains them.
3. Leave routines disabled and configure no personal endpoints, repository paths or credentials in the shared profile. Each recipient connects their own bridge after importing.
4. Open the Bot's Share menu and create a template draft. Inspect **View template details** for the intended role, instructions and skills. Remove unrelated context, memories, routines, accounts, internal URLs and private data. Check that no personal connector URL has been embedded. Do not share a working QA Bot as the community template.
5. Use [LISTING.md](LISTING.md) as the public description. Publish a public or team-only template only after reviewing its exact contents and choosing its visibility. Copy the platform-generated URL into your release announcement; this kit does not invent a template URL. Marketplace placement is not established by building this archive.

Grok Bot's [official template guide](https://x.ai/bot/guides/templates-for-grok-bot) explains that custom MCP servers/scripts do not travel with a template. The [Bot sharing documentation](https://docs.x.ai/grok-bot/bots#share-a-bot) describes the native sharing flow. The template provides the role; the runtime below supplies the tools.

A fresh Bot can still see account-shared tools. In the preparation check, a new private draft spontaneously discovered the owner's existing bridge during its greeting; it was stopped and not cleared for sharing. Do not assume that “new Bot” means empty account context. Review the native template's actual contents, not merely the Bot's claim that it is clean. See the [official shared-computer boundary](https://docs.x.ai/grok-bot/approvals-security-and-privacy#understand-the-shared-computer-boundary).

## What a recipient installs

1. Add the reviewed Bot through its actual template link, or create it manually from this kit.
2. Download the separate `grok-bot-mcp-agent-VERSION.tgz` runtime and its checksum from the same trusted release. Node.js 22+, npm, Git and a supported coding CLI are prerequisites.
3. Follow [standalone setup](../docs/STANDALONE.md): install the runtime, enroll a Git repository and verifier, enroll the exact ACP executable/model, expose the authenticated HTTPS gateway at an owner-controlled URL, and approve its OAuth enrollment locally.
4. Tell the Bot which connector to use and supply your own repository, provider and exact model. Never send credentials in chat. Importing the Bot does not install local software, copy the creator's credentials, expose localhost, or authorize provider accounts.
5. Run [ACCEPTANCE.md](ACCEPTANCE.md) before delegating real coding work.

Normal use needs no repeated executable paths or token copying. The coding host must remain awake, online and signed in, with its bridge and tunnel running. T3 is optional. OAuth reapproval is required after the bridge token's 30-day lifetime or revocation. Grok Bot's own Auto Review and administrator rules remain authoritative.

## Maintainer downloads

Run `npm run pack:community` from the source checkout. It builds the runtime and this documentation-only template kit, writes SHA-256 sidecars and a release manifest under `build/releases`, and performs no account enrollment or publication. See [distribution](../docs/DISTRIBUTION.md).
