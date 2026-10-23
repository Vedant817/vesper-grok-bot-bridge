# Build and distribute downloads

The community distribution has two parts: a Grok Bot template kit and an installable CLI/MCP runtime. Neither includes user configuration or credentials. This repository is an unofficial community integration; it does not distribute Grok Bot, T3 Code, provider subscriptions, or an approved marketplace plugin.

## Community pair: Bot template and CLI/MCP runtime

With locked dependencies installed (`npm ci`), build both downloads:

```sh
npm run pack:community
```

The default output is `build/releases`; pass `npm run pack:community -- /absolute/output/directory` for another location.

| Download | Recipient action |
| --- | --- |
| `grok-coding-supervisor-template-0.1.0.tgz` | Extract and open `package/README.md`. It contains the clean Bot profile, role, listing copy, native sharing steps and acceptance prompts. It is documentation, not an npm install or native import format. |
| `grok-bot-mcp-agent-0.1.0.tgz` | Install with `npm install -g ./grok-bot-mcp-agent-0.1.0.tgz`, then follow standalone setup. It supplies the background CLI launcher and MCP tools. |

Each archive has a `.sha256` sidecar. `community-release.json` records filenames, hashes, included files and the fact that nothing has been published. The template kit's private manifest has no scripts or dependencies. All connector URLs, CLI login, provider/model choices, repository paths, verifier and OAuth approvals belong to the recipient.

Follow the [template preparation guide](../community/README.md) before publishing through Grok Bot's native Share menu. Check **View template details**; do not share a QA Bot containing private context or the author's connector. A platform-generated template link is required for Add to Grok Bot. This build neither generates that link nor establishes marketplace placement. Custom MCP code is installed separately, as explained in the [official template guide](https://x.ai/bot/guides/templates-for-grok-bot).

## Native T3 onboarding kit (recommended for Grok Bot + T3)

T3 already exposes the remote MCP server. Users need the setup instructions and bot role, not another daemon. With Node.js 22+ and npm available, build the kit from a checkout:

```sh
npm run pack:onboarding
```

This creates `build/releases/grok-bot-t3-connect-kit-0.1.0.tgz` and a `.sha256` sidecar. It copies only the quickstart, bot role, README, license, and a private package manifest. It has no runtime code, dependencies, scripts, credentials, or configured endpoint. Recipients extract it with an archive manager and open `package/README.md`; they do not run `npm install`. The private manifest prevents accidental npm publication of the documentation kit.

To build into another directory, use `npm run pack:onboarding -- /absolute/output/directory`. The archive is a normal gzip-compressed tar file; for example, `tar -xzf <archive.tgz>` extracts it in the current directory.

Recipients should compare the download's SHA-256 with a checksum obtained from a trusted release channel. A checksum beside a modified download is not publisher authentication.

## Build only the multi-CLI MCP bridge package

This is the runtime download for background coding CLIs without T3. Follow [standalone setup](STANDALONE.md) after installation to enroll ACP providers and the HTTPS/OAuth gateway. The documentation-only T3 kit does not include this runtime.

Users who want direct native CLI adapters outside T3 can install the existing CLI/MCP package. Maintainers build it from a checkout with locked dependencies:

```sh
npm ci
npm run lint
npm pack --pack-destination build/releases
```

Run `npm run pack:onboarding` first to create the output directory, or create that directory yourself. `prepack` builds TypeScript and includes the tested lockfile as `runtime-lock.json`. The package includes the native T3 guide alongside the optional bridge documentation.

Recipients need Node.js 22+, npm, Git, and their selected coding CLIs with native authentication. Install the downloaded archive by its local path:

```sh
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository /absolute/path/to/repository
grok-agent-bridge doctor
```

Windows PowerShell also accepts forward slashes in the repository path. Existing shells may need restarting after setup; an already-running host may retain an older PATH. Configure native stdio clients with absolute Node/launcher paths when needed. Do not publish your managed installation directory or its DPAPI blobs as an installer. See [bridge setup](BRIDGE.md) for supported platforms, owner enrollment, verifier requirements, and startup boundaries.

## Release checklist

1. Review the final changes and [verification limits](VERIFICATION.md). For runtime changes run the relevant tests; on Windows the documented serial gate avoids the known parallel headless native PTY failure.
2. Build both intended artifacts. Inspect `tar -tzf <archive>` and npm's pack file list. Exclude `.env`, owner configuration, tokens, credentials, task state, logs, screenshots, and real user endpoints.
3. Extract the documentation kit into a fresh directory and check that its local Markdown links resolve. Give users the new-thread/continuation acceptance prompt, not a claim of universal certification.
4. Compute and distribute checksums through a trusted channel. Upload artifacts to your chosen release host only after choosing that host and its visibility. No repository remote, public release, npm publication, or marketplace listing is configured by this workflow.
5. For npm registry publication, separately establish package ownership, provenance, versioning and publisher authentication. The local tarball does not imply that `npm install -g grok-bot-mcp-agent` resolves to this project.

Building downloads does not enroll accounts, issue credentials, modify installed services, change sleep settings, or publish anything online. Native Grok Bot OAuth acceptance and the optional bridge's own T3 enrollment are separate flows.
