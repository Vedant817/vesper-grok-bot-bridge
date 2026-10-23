# Contributing

Start with [the route guide](docs/ROUTES.md) and [provider policy](docs/PROVIDER_POLICY.md). Keep T3's native `t3_*` contract separate from the standalone bridge's `agent_*` contract. The root README is the user entry point; detailed instructions belong in `docs/`.

## Directory map

```text
community/cli/       CLI Bot profile, listing, creation and acceptance source
community/t3/        T3 Bot profile and listing source
docs/               Setup, policy, protocols and verification guides
docs/research/      Evaluated optional projects; no runtime dependencies
examples/           Public owner-configuration examples, never real credentials
scripts/            Release builders and package preparation
src/adapters/       ACP, Codex, Claude, T3 and terminal protocol workers
src/bridge/         Session service, task routing, tools, monitoring, provider discovery
src/connect/        T3 Connect enrollment, credential storage and transport
src/managed/        Per-user install, launcher, clients and startup
src/remote/         Standalone HTTPS MCP, OAuth, owner approval and tunnel lifecycle
src/*.ts            Public entrypoints, shared contracts and legacy supervisor modules
tests/              Unit/integration tests and protocol fixtures
.github/workflows/  CI
```

`src/connect/` connects outward to T3; `src/remote/` serves this bridge's inward MCP endpoint. They are not duplicates. The root legacy/shared modules remain because public exports, tests and advanced users depend on them; moving or deleting them needs a migration, not a cosmetic cleanup.

Ignored generated directories: `dist/` is compiler output; `node_modules/` contains local dependencies; `build/releases/` contains distributable archives. Other `build/` material can include temporary checks, local helpers or retained acceptance evidence. Do not blanket-delete `build/`, an installed managed home, worktrees, test evidence or another contributor's files. Runtime state is per-user outside the source checkout, not a repository directory to distribute.

## Local workflow

Requires Node.js 22+ (CI uses 24), npm and Git. Install locked dependencies with `npm ci`, then run:

```sh
npm run lint
npm test -- --no-file-parallelism --maxWorkers 1
npm run build
```

Use focused tests while implementing. The serial full gate avoids a known Windows headless native PTY concurrency issue. Tests use disposable repositories/protocol fixtures; they are not provider-account or reboot certification. Do not launch a real worker, install global clients, enroll accounts or change startup settings just to run repository tests.

For packaging changes, build with `npm run pack:community`; verify archives, checksums, included files and local Markdown links. See [release instructions](docs/DISTRIBUTION.md). Keep generated archives, owner config, tokens, personal endpoints and logs out of Git. Prefer small semantic commits and independent review at feature checkpoints.

## Adapter changes

Discover exact capabilities and model IDs. Preserve offered permission choices, human-only input and native denials. Maintain stable native IDs and uncertain-execution ownership across disconnects; never retry an uncertain start/continuation automatically. New ACP support needs actual protocol and authentication checks, not a label in a template. Do not silently substitute providers/models or use subscription credentials outside their permitted deployment model.

Share source profiles through `community/` and publish templates through Grok Bot's supported UI. Do not claim a local archive creates a marketplace listing, or bundle custom MCP code as if native templates install it. Do not publish the existing private QA/draft Bots or their account context.
