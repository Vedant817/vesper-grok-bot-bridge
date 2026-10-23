# Build and distribute

## What community members receive

Publish **two focused Bot templates** through Grok Bot's supported sharing flow: [T3 Coding Supervisor](../community/t3/README.md) and [CLI Coding Supervisor](../community/cli/README.md). Members add their copy from Marketplace or a genuine template link. A shared link does not automatically establish catalog placement. No public template URL or npm release is configured here.

T3 recipients connect T3's existing MCP server; they do not install this bridge. CLI recipients separately install this project's runtime and connect their own bridge. Custom MCP code does not travel with a native Bot template. See [the route comparison](ROUTES.md) and [official template guide](https://x.ai/bot/guides/templates-for-grok-bot).

## Build once for a release

Requires Node.js 22+, npm and Git. From the source checkout:

```sh
npm ci
npm run lint
npm run pack:community
```

Optional output directory: `npm run pack:community -- /absolute/output/directory`.

| Artifact under build/releases | Audience and purpose |
| --- | --- |
| `grok-bot-mcp-agent-0.1.0.tgz` | CLI-route recipients install this runtime. Includes CLI/MCP code, public guides and the tested runtime lock. |
| `grok-coding-supervisor-template-0.1.0.tgz` | Publishers/contributors extract this source kit for both Bot profiles, roles, listing copy and acceptance steps. Not required for ordinary marketplace users. No executable code, install scripts or dependencies; private package manifest. |
| `*.sha256` | Archive checksums; obtain the expected hash from a trusted publisher channel. A hash beside an altered archive is not publisher authentication. |
| `community-release.json` | Artifact hashes, byte counts, file lists and separate unpublished T3/CLI template-link fields. |

`npm run pack:onboarding` is a compatibility alias for the same pair builder. The old separate T3 documentation-only builder was consolidated; historical T3 kit receipts in the verification log describe earlier releases.

## Install the standalone runtime

```powershell
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository C:/Code/my-project
grok-agent-bridge doctor
```

Continue with [standalone setup](STANDALONE.md) to enroll the real verifier, exact native provider/model, stable HTTPS endpoint and OAuth. The package does not include provider binaries, subscriptions, credentials or a hosted tunnel. Each recipient logs into supported providers under their own agreement. See [provider-policy review](PROVIDER_POLICY.md).

Windows accepts forward slashes in repository paths. Existing terminals/clients may need a one-time restart after PATH registration. Do not distribute the managed installation home, DPAPI blobs, state, native auth files or worktrees as an installer. [Managed setup and recovery](BRIDGE.md).

## Publish the templates and release

1. Use [the publisher guide](../community/README.md) and the route-specific profile/role. Create fresh private drafts with no initial task, startup discovery or routines. Do not share existing QA Bots or the current account-context-bearing draft.
2. Inspect native **View template details**. Include only the intended role/skills and disclosures. Exclude personal connectors, endpoints, memories, paths, credentials and unrelated integrations. Creating a fresh Bot alone does not establish clean contents.
3. Choose visibility and publish only after owner review. Copy the actual platform-generated T3 and CLI links into the release announcement. Marketplace placement remains the platform's process, not a local build result. Do not insert invented link placeholders as usable Add links.
4. Inspect both archives, local documentation links, manifest and checksums. Exclude secrets, generated reports and real endpoints. Extract the source kit in a disposable directory. Check the runtime's install/CLI path without enrolling accounts or modifying services.
5. Publish archives and hashes through the selected trusted release channel. No Git remote or publisher account is configured here. Public npm publication additionally needs package ownership, authentication, provenance and versioning; installing a local tarball does not establish a registry package.

Packaging does not enroll accounts, change startup or sleep settings, create templates, publish anything, or imply xAI/provider endorsement. Applicable vendor rules and recipient approvals remain in force.
