# Build and distribute downloads

Two different downloads serve different users. Neither includes user configuration or credentials. This repository is an unofficial community integration; it does not distribute Grok Bot, T3 Code, provider subscriptions, or an approved marketplace plugin.

## Native T3 onboarding kit (recommended for Grok Bot + T3)

T3 already exposes the remote MCP server. Users need the setup instructions and bot role, not another daemon. With Node.js 22+ and npm available, build the kit from a checkout:

```sh
npm run pack:onboarding
```

This creates `build/releases/grok-bot-t3-connect-kit-0.1.0.tgz` and a `.sha256` sidecar. It copies only the quickstart, bot role, README, license, and a private package manifest. It has no runtime code, dependencies, scripts, credentials, or configured endpoint. Recipients extract it with an archive manager and open `package/README.md`; they do not run `npm install`. The private manifest prevents accidental npm publication of the documentation kit.

To build into another directory, use `npm run pack:onboarding -- /absolute/output/directory`. The archive is a normal gzip-compressed tar file; for example, `tar -xzf <archive.tgz>` extracts it in the current directory.

Recipients should compare the download's SHA-256 with a checksum obtained from a trusted release channel. A checksum beside a modified download is not publisher authentication.

## Optional multi-CLI MCP bridge package

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
