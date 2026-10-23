# Coding Agent Bridge for Grok Bot

Use Grok Bot to supervise coding agents: start a task, inspect the agent's response, resolve delegated technical input, request improvements in the same session, and review real verification before accepting work.

## Choose your setup

We maintain **two focused Bot templates**, with different tool contracts. [Full route comparison](docs/ROUTES.md).

| What you use | Bot template | MCP server | Setup guide |
| --- | --- | --- | --- |
| T3 Code | [Keystone — T3](community/t3/PROFILE.md) | T3 already supplies its server through T3 Connect; no bridge install | [T3 setup](docs/T3_CONNECT_QUICKSTART.md) |
| Coding CLIs without T3 | [Keystone — CLI](community/cli/PROFILE.md) | Install this project's CLI/MCP bridge once; enroll multiple ACP/native CLIs | [Standalone MCP setup](docs/STANDALONE.md), [provider enrollment](docs/CLI_CONNECTIONS.md) |

Recipients add a published Bot through Grok Bot Marketplace or a real shared template link. The profiles above are publisher source files, not marketplace links. **No marketplace listing or public template URL is published by this repository yet.** Custom MCP servers are installed separately; importing a Bot does not install software or authenticate coding accounts. [Template publishing details](community/README.md).

A combined Bot is optional for advanced users who connect both resources and select the route explicitly. It is not the default offering and must never silently move work between backends. There is one MCP server implementation in this repository, not one server per CLI. T3's server is a separate product.

## Standalone MCP: install once

Requires Node.js 22+, npm, Git and your chosen authenticated coding CLI/ACP adapter. Download this project's runtime archive from a trusted release, verify its checksum, then install it by local path:

```powershell
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository C:/Code/my-project
grok-agent-bridge doctor
```

For repositories without a suitable detected test/check command, enroll the real verifier explicitly. Then enroll your exact ACP executable/model, configure a stable owner-controlled HTTPS gateway and approve OAuth locally. **Continue with [the complete standalone guide](docs/STANDALONE.md)**; the three commands above alone do not connect Grok Bot's cloud connector to your computer.

Setup persists per-user paths and credentials and configures supported sign-in startup. Workers run in background isolated Git worktrees; no visible terminal or T3 installation is required. A single installed bridge can operate multiple owner-enrolled CLIs. Local MCP hosts can use `grok-agent-bridge connect` over stdio. Grok Bot uses the authenticated HTTPS/OAuth route. No xAI API key is needed when Grok Bot supplies reasoning.

## T3 MCP: connect once

Install and configure T3 Code and its coding provider, enable T3 Connect, then add your environment's HTTPS `/mcp` URL as a remote Grok Bot connector and approve native OAuth. Do not install this bridge merely to use T3. Follow [T3 setup and acceptance](docs/T3_CONNECT_QUICKSTART.md) and [the T3 Bot role](docs/T3_BOT_INSTRUCTIONS.md).

## Permissions, accounts and availability

Use your own accounts and approved authentication. Keep native approvals, administrator controls and budgets in force. Credentials, MFA, CAPTCHA, payment and human-only approvals remain human handoffs. Stop on quota/policy failures; no account rotation, token extraction, silent model substitution or uncertain task replay. The bridge is not an OS sandbox or a multi-tenant credential proxy.

Read [the current provider-policy review](docs/PROVIDER_POLICY.md) before use or publication. It covers OpenAI, Anthropic, xAI and other workers, including subscription-versus-API and hosted/commercial boundaries. ACP support and passing tests are not vendor approval, and nobody can guarantee immunity from account restrictions.

The coding computer must stay awake and online with its selected backend and tunnel running. Persisted enrollment is not a promise of indefinite OAuth validity. Native Grok Bot approval cards can still interrupt unattended work; physical reboot and app-closed operation remain separate acceptance limits. [Live results and limitations](docs/CLI_CONNECTIONS.md), [verification history](docs/VERIFICATION.md).

## Develop and distribute

```sh
npm ci
npm run lint
npm test -- --no-file-parallelism --maxWorkers 1
npm run build
npm run pack:community
```

The final command builds the installable CLI/MCP runtime and a **publisher source kit containing both Bot definitions**, with SHA-256 sidecars and a release manifest under `build/releases/`. Ordinary marketplace users do not need the source kit. Nothing is published, enrolled or installed globally by that build. [Distribution guide](docs/DISTRIBUTION.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the directory map and contribution workflow, and [the documentation index](docs/README.md) for all guides. The optional [legacy API-key supervisor](docs/LEGACY_SUPERVISOR.md) is documented separately.

Unofficial community integration under [MIT](LICENSE); no vendor endorsement, account-policy approval, public npm publication or universal provider certification is implied.
