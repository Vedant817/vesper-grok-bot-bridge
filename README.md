# Coding Agent Bridge for Grok Bot

For **Grok Bot controlling T3 Code**, start with the [native MCP quickstart](docs/T3_CONNECT_QUICKSTART.md) and [copyable bot role](docs/T3_BOT_INSTRUCTIONS.md). T3 already provides the HTTPS MCP server: add its public T3 Connect URL as a native Grok Bot connector and approve OAuth. No bridge installation, terminal communication, or xAI API key is required for that route. This is an unofficial community integration, not vendor certification.

Build a shareable documentation kit with `npm run pack:onboarding`. Recipients extract it and follow the guide; nothing needs executing. The [distribution guide](docs/DISTRIBUTION.md) also covers building the optional CLI package, checksums, and release limits. Downloads are built locally; no npm or public marketplace publication is implied.

The coding host must remain awake and online with T3's backend/tunnel running. On the current Windows desktop setup, keep T3 Code running (minimized is fine). Grok Bot's desktop window can close when using its cloud-hosted native HTTPS connector. See the quickstart's availability table for service and mobile use.

## Optional bridge for coding CLIs outside T3

Grok Bot can supervise installed coding agents through this portable MCP bridge: choose a directory, provider and model; start or enter a session; answer questions and permissions; review work; send corrections; and finish only with passing verification. Grok Bot supplies the reasoning through its own subscription. The bridge does **not** require an `XAI_API_KEY`.

Start with the [portable bridge setup and Grok Bot instructions](docs/BRIDGE.md) and [owner configuration example](examples/bridge.json). Native adapters support Codex app-server, OpenCode/ACP, Grok Build/ACP and Claude Code stream JSON, with optional T3 Code MCP discovery. [General ACP enrollment and actual live results](docs/CLI_CONNECTIONS.md) cover maintained Codex/Claude adapters and Google's standalone Antigravity ACP server. Installing an application alone does not establish authentication or session control.

The worker directory is a runtime argument, constrained by owner-enrolled repositories. Product code contains no required checkout path or dependency on a generated report. Grok Bot's local-command permission or a compatible MCP connection is still required to reach the machine; a cloud Bot cannot reach desktop localhost by installation alone.

## Managed installation

For this Windows machine, setup can install a persistent per-user bridge, register the installed coding clients, and enable automatic startup after sign-in. Run setup once; daily commands discover the saved paths, credentials and endpoint automatically:

```sh
grok-agent-bridge doctor
grok-agent-bridge call agent_discover
```

Existing terminals and coding clients may need a one-time restart after installation. Grok Bot uses the installed command through approved local execution; its own application permissions remain in force.

Install the packed CLI once, then let it provision a private home, credentials, MCP client entries, and a restart-safe local daemon:

```sh
npm pack
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository /absolute/path/to/repo
grok-agent-bridge doctor
```

`setup` accepts `--home`, `--no-clients`, `--no-autostart`, `--force-setup-lock`, and an explicit `--verify-executable`/`--verify-args`. Every later command accepts `--home`. Setup stages and smoke-tests the release before switching, refuses to harden directories it does not own, reclaims locks left by dead processes, and reports installation, credential, PTY, and autostart status; `doctor` also reports launcher presence and release validity. Use `--force-setup-lock` only after confirming the recorded setup process is not running. See [managed installation](docs/BRIDGE.md#managed-installation-recommended) for the security model and recovery behavior.

The older autonomous API-key supervisor remains available below for compatibility.

## Legacy autonomous supervisor

A TypeScript supervisor for isolated coding tasks over T3 MCP, ACP v1, Codex app-server and a conservative terminal fallback. Grok answers technical questions and evaluates evidence; deterministic policy controls intercepted permission requests.

This implementation is locally tested. It is not a claim of universal provider certification or an operating-system sandbox. Read [verification and limits](docs/VERIFICATION.md) before running real workers.

## Start

Requires Node.js 22+ and Git. Use the checked-in npm lockfile.

```sh
npm ci
npm run check
node dist/index.js --help
node dist/index.js run /path/to/config.json "Reproduce and repair the defect; add a regression test"
node dist/index.js run-plan /path/to/config.json examples/tasks.json
```

Copy an [example configuration](examples/codex.json), replace its absolute paths, choose a model available to your xAI account, and supply `XAI_API_KEY` in the process environment. Never commit credentials. Configurations are trusted owner input: setup, worker and verifier executable/argv are selected by you, never by the worker or model.

On Windows, JSON paths can use `C:/...`. Executables must be native programs or a runtime such as `node` with its script path. Shell wrappers (`.cmd`, `.ps1`) are not directly launched. The examples' `scripts/verify.mjs` means your repository's real validation script; it is not an included no-op verifier. Optional `setup` has the same executable/args/env shape as `verify`, and can install locked dependencies in the new worktree before a worker starts.

Every task starts from committed `HEAD` in a fresh detached linked worktree outside the source repository. Uncommitted source files and `node_modules` are not copied. Results report completed/stopped/failed and a retained worktree path; stopped/failed CLI tasks exit nonzero. Review and integrate that worktree yourself. No worktree is automatically deleted, merged or pushed.

Plans validate their DAG before executing, skip dependents after failure, and pass completed dependency receipts as read-only context. Each milestone starts independently from source HEAD. Plan execution does not compose patches across worktrees.

## MCP host

```sh
node dist/index.js serve-stdio /path/to/config.json
node dist/index.js serve-http /path/to/config.json 3001
```

HTTP requires a random `MCP_SERVER_TOKEN` of at least 24 characters and binds only `127.0.0.1`. Clients send `Authorization: Bearer <token>` on every request. Cross-origin browser requests and nonloopback Host headers are rejected. Streamable HTTP is at `/mcp`, legacy SSE at `/sse`, and legacy message POSTs at `/messages`.

Both requested versions, `2025-06-18` and `2024-11-05`, have actual loopback negotiation tests. The client proposes `2025-06-18` and accepts SDK-supported older responses. Transport fallback occurs only on 404/405, never authentication failure. Persistent authenticated sessions propagate request cancellation. HTTP caps active sessions at 16 and expires idle sessions after an hour. One task runs at a time per application.

Tools are `permission_evaluate` (classification without execution), `question_resolve` (technical Grok answers), and `supervisor_run` (isolated task with the owner-selected worker and verifier). Stdio stdout contains MCP frames only.

## Adapters

| Adapter | Implemented | Boundary |
| --- | --- | --- |
| T3 | Runtime discovery, authenticated MCP, explicit workspace binding, launch/read/wait, single questions, send auto/steer/restart, interrupt | Needs projectId and T3_BEARER_TOKEN. Pending-question MCP cannot approve runtime permissions; these fail explicitly. Launch is never automatically retried. |
| ACP v1 | JSON-RPC stdio initialize/new/prompt/update/cancel and permission selection | `session/prompt` is the standard turn method. Unknown methods are rejected. Elicitation is declined because its human-review requirement cannot be met autonomously. `_supervisor/ask_question` is an opt-in nonstandard technical-question extension. |
| Codex | Stdio or loopback WebSocket app-server, thread/turn lifecycle, scoped approvals/questions, interrupt | Requests untrusted approval policy and workspace-write sandbox. Additional permission grants and MCP elicitation are denied. Requires its own authentication. |
| PTY | Optional native node-pty, streamed output, exit status, conservative prompt detection | Approval-shaped prompts stop the process. No approval keystrokes, arbitrary terminal steering or claim that text detection authenticates a prompt. |

Child processes inherit a small OS environment allowlist. Additional environment entries require explicit worker.env/setup.env/verify.env. The supervisor's xAI key is not inherited. Home-directory credentials remain reachable without OS isolation.

## Safety and evidence

Only exact structured read-only git argv tuples are eligible for auto-approval. Shell strings, unknown commands, writes and ambiguous paths are refused; destructive/credential-shaped operations are blocked. Models cannot override policy. The firewall covers intercepted requests; it cannot stop operations a worker performs without asking.

Completion requires a successful owner-configured verifier and positive Grok evaluation. Failed verification cannot be overruled. Turn/event/time caps, repeated-question detection, content-based repair-loop detection, bounded queues and bounded cleanup waits stop runaway work. Grok uses the xAI Responses API with store:false, no tools, bounded requests, validated JSON decisions and no automatic retries.

Working memory is capped at 6,000 UTF-8 bytes. Full redacted records are stored by SHA-256 under stateDirectory/runs/<id>/cold, with result.json receipts alongside them. The model has a separate 6,000-byte input-content cap. Oversized evaluation evidence is refused. Tracked diffs are hashed as streams; summaries include file counts, content hashes and changed JS/TS AST symbol names. Large AST files are explicitly omitted.

Secret filtering covers configured values, common tokens, bearer values and PEM blocks, including split records. Redaction occurs before JSON escaping. After an oversized partial stream record, subsequent records are suppressed until the stream ends. This is not a universal secret detector: use scoped credentials and OS isolation.

State is retained for inspection. There is no automatic crash replay, cross-process lease, storage quota or retention daemon. Review failed or aborted sessions before rerunning. Multiple independent supervisor processes need external coordination.

## Development

```sh
npm run lint
npm test
npm run build
npm audit --audit-level=moderate
npm pack --dry-run
```

Lint means strict production and test TypeScript checks. Tests include real loopback HTTP/SSE, subprocess and native PTY integrations; no paid inference is required. See [architecture](docs/ARCHITECTURE.md), [protocol sources](docs/PROTOCOLS.md), and [verification](docs/VERIFICATION.md).
