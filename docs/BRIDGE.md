# Portable coding agent bridge

For background CLI control without T3, use the [standalone HTTPS/OAuth setup](STANDALONE.md). Grok Bot's cloud connectors cannot execute a local Windows stdio command. The gateway keeps that communication on MCP; local-command examples below are optional compatibility routes, not the recommended Grok Bot setup.

For native Grok Bot control of T3 threads, follow the [T3 Connect quickstart](T3_CONNECT_QUICKSTART.md). T3 already provides the remote MCP server; this optional bridge and its setup commands are for the separate multi-CLI route.

Grok Bot is the supervisor. The bridge exposes native coding sessions as MCP tools. Each request selects a provider, exact model and directory. The bridge does not call an xAI reasoning API and does not use Grok Build as a replacement for the Grok Bot application.

See [persistent supervision and T3 Connect](SUPERVISION.md) for one-time OAuth enrollment, task-aware new/continue routing, monitoring, crash-recovery rules and provider boundaries.

## Managed installation (recommended)

`setup` creates a per-user installation separate from the checkout, hardens its directory, stores a DPAPI-encrypted bearer token, installs MCP client entries, and starts a restart-safe local daemon.

On a source checkout with Node.js 22+ and Git already installed, the one-time setup can also be run directly:

```sh
npm ci
npm run build
node dist/index.js setup
```

Run it from the repository you want to enroll, or use `--repository <folder>` once. Setup derives the installation paths and detects the repository's `check` or `test` script. Other projects need an explicit verifier once. Installed coding agents retain their own authentication.

After setup, open a new terminal and restart existing coding-client sessions once to load the saved PATH and MCP entry. Daily use needs no owner-file path, port, bearer token, environment file, or source-checkout location:

```sh
grok-agent-bridge doctor
grok-agent-bridge call agent_discover
grok-agent-bridge call agent_start @task.json
```

The daemon starts automatically after Windows sign-in and is also started on demand by clients. Each proxy request discovers the current endpoint, so an already-open MCP client can reconnect after the daemon restarts. This does not automatically resume interrupted coding turns: inspect them and use `agent_resume`. The scheduled task runs as the current user without elevation; before-sign-in system-service startup is not provided.

For Grok Bot's optional local-terminal route, enable its approved local execution capability once, then give it the installed `GROK_BOT_INSTRUCTIONS.md` job description. It can use `grok-agent-bridge call ...` through the local terminal without handling bridge credentials. Grok Bot's application approval policy still applies. The observed desktop handoff ran read-only bridge health/discovery using absolute Node/launcher paths after its inherited PATH failed; full Bot-driven coding supervision through this route remains unverified. Native T3 communication instead uses the separate HTTPS connector guide above.

```sh
npm pack
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository /absolute/path/to/repo
```

On Windows the default home is `%LOCALAPPDATA%\GrokAgentBridge`; elsewhere it is `${XDG_DATA_HOME:-~/.local/share}/grok-agent-bridge`. Use `--home <folder>` to install elsewhere. Every managed command accepts `--home`, so a custom installation is never silently missed:

```sh
grok-agent-bridge doctor --home D:/bridge        # JSON report; exit 1 when stopped or broken
grok-agent-bridge enroll D:/work/project         # add a repository and verifier
grok-agent-bridge start --home D:/bridge
grok-agent-bridge call agent_discover --home D:/bridge
grok-agent-bridge stop --home D:/bridge
grok-agent-bridge autostart enable|disable
```

Setup stages a release under `<home>/releases`, installs production dependencies with `npm ci --omit=dev`, import-smoke-tests the staged entrypoint, and only then swaps `installation.json` atomically. A failed or interrupted stage is removed, and a previous release is retained for rollback. Interrupted setup and daemon locks are reclaimed automatically once their process is gone. A setup lock whose recorded PID is still alive is never stolen by age, because a suspended setup can resume; if that PID was reused by an unrelated process, confirm no setup is running and rerun setup with `--force-setup-lock`. Malformed `owner.json` or `installation.json` is quarantined as `*.invalid-<timestamp>` instead of blocking every later run. Credential rotation is staged before the old blob is moved aside, and a daemon that answers the authenticated control channel is stopped before its token is replaced. If the channel cannot be verified while `daemon-owner.json` records a live PID, setup refuses to rotate and names the key or process to recover. `doctor` reports the installed version and release validity, enrolled root count, credential readability, PTY availability, launcher presence, autostart mode, and the last startup error. It exits nonzero when the daemon is stopped or when the published release, launcher, credential, or enrolled owner configuration is missing, malformed, or unreadable.

An absent runtime receipt does not prove that the daemon stopped: setup also checks its owner record. If that record is malformed or unreadable, its age does not authorize replacement. Confirm the daemon is stopped before repairing that record; setup preserves configuration and credentials while identity is uncertain.

Client registration is conservative: Codex, Claude, and OpenCode are registered only when the bridge entry is absent. An existing entry that points somewhere else is reported as `existing-entry-differs` instead of being overwritten. OpenCode JSONC comments and unrelated providers are preserved.

Autostart uses a hidden VBS trampoline behind a per-installation scheduled task, with the current-user Startup folder as a fallback. It never requests elevation.

Security boundaries:

- The daemon binds only `127.0.0.1` and requires the bearer token at `/mcp` and `/sse`.
- The control channel authenticates requests and responses with HMAC-SHA256 using `<home>/control.key`. The bearer token is never sent over the named pipe; a stale receipt or squatted pipe name is not a capability.
- The managed home is owner-only. Setup refuses to strip inheritance from a non-empty directory it does not already own.
- Tool arguments and provider output remain untrusted; commands and environment values come only from owner configuration.

Known limits: Windows is the only autostart platform, `node-pty` is optional and not built by the staged `npm ci` (the `pty` field in the setup/doctor report records availability), and native executables are preferred over `.cmd`/`.ps1` shims. An npm-only client is resolved through its package's declared JavaScript `bin` entry instead of being executed through a shell. Non-ASCII home paths are preserved end to end: the CLI shim stays ASCII-only and resolves the launcher from its own directory, and the logon script is written as UTF-16LE with a BOM for Windows Script Host. Because the shim cannot embed a non-ASCII Node path, it resolves `node` from `PATH`; the installed launcher and autostart record the Node executable path used at setup (an nvm junction can change the version behind that path). Windows home paths containing `%` or `;` are rejected because logon expansion and PATH splitting would corrupt them.

## Manual installation and enrollment

Requires Node 22+, Git, and the coding CLI you want to use, authenticated through that CLI's supported login. An installation containing only Grok Bot cannot run a missing Codex or Claude executable. Discovery reports missing interfaces; it never installs or substitutes agents automatically.

```sh
npm ci
npm run check
npm link
```

Copy `examples/bridge.json` to a private owner configuration outside your repository. Replace its paths with your own absolute paths (Windows JSON may use `C:/...`). Add each repository under `roots`. `verify` must run that project's actual test/build gate. `scripts/verify.mjs` is a placeholder for your own real script, not a supplied always-pass check. Commands and environment values are trusted owner configuration, never MCP tool arguments. Keep credentials out of Git.

The state directory must be outside and separate from enrolled repositories. New tasks create detached Git worktrees from committed HEAD; uncommitted source changes, dependencies and ignored files are not copied. The requested subdirectory must exist in committed HEAD. Install/build prerequisites through your existing project workflow before expecting tests to pass. Worktrees are retained; finishing does not commit, merge, push or delete them.

```sh
grok-supervisor bridge-discover /absolute/path/owner.json
grok-supervisor bridge-stdio /absolute/path/owner.json
```

For an MCP client with local stdio configuration:

```json
{
  "mcpServers": {
    "coding-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/installed-package/dist/index.js", "bridge-stdio", "/absolute/path/owner.json"]
    }
  }
}
```

Use the client's documented MCP configuration. On Windows use native executables such as `node.exe`, rather than passing a `.cmd` or `.ps1` wrapper to a shell-free launcher.

## Grok Bot desktop connection

[Official Grok Bot documentation](https://docs.x.ai/grok-bot/computer-and-apps) distinguishes its cloud computer from your local machine. Its [settings documentation](https://docs.x.ai/grok-bot/settings-and-notifications) describes **General → Bot → Execution on Local Computer**, with per-command approval by default. Keep that policy under your control.

The documentation reviewed for this release describes Connect apps plugins, but does not establish a user-configurable arbitrary local stdio MCP entry for Grok Bot. Do not assume the generic JSON above can simply be pasted into that application. If your installed version offers a custom MCP connector, use its documented flow. Otherwise, a Bot with approved **local terminal execution** can use the wrapper below. This does not require desktop clicks, app-private credentials or a public tunnel.

Start a persistent local host with a random `MCP_SERVER_TOKEN` of at least 24 characters in its environment:

```sh
grok-supervisor bridge-http /absolute/path/owner.json 3001
```

Supply the same token to the approved local wrapper process through its private environment. Never paste it into Bot chat or put it in command arguments. Keep the host alive; do not launch a new host for every tool call. It binds only `127.0.0.1` and serves authenticated Streamable HTTP at `/mcp` and legacy SSE at `/sse`.

The Bot can call tools through its local terminal:

```sh
grok-supervisor bridge-call http://127.0.0.1:3001/mcp agent_discover
grok-supervisor bridge-call http://127.0.0.1:3001/mcp agent_start /absolute/path/task-arguments.json
```

`task-arguments.json`:

```json
{
  "provider": "codex",
  "model": "EXACT_MODEL_ID_FROM_DISCOVERY",
  "directory": "/absolute/path/to/enrolled-repository",
  "task": "Implement the requested feature and run the project's checks.",
  "requestId": "unique-task-id-retained-across-retries"
}
```

Every `bridge-call` returns JSON. Use JSON argument files for subsequent tools too; no shell quoting or command interpolation is necessary. A wrapper disconnect does not cancel the worker. A stopped bridge process requires explicit native session resume. Only one process may own a state directory.

If a process crashes during ownership acquisition, it can leave a `stateDirectory/owner-acquisition` guard directory. Startup then fails closed. Verify that every bridge process using that exact state directory is stopped before removing that empty guard and restarting; do not delete session files or retained worktrees. An ordinary dead owner's PID is checked on restart. PID reuse or unverifiable process ownership is treated conservatively as a live owner.

The managed daemon uses `<home>/daemon-acquisition` and `<home>/daemon-owner.json` for the same single-owner guarantee. A recorded PID is treated as live even if it was recycled. If startup reports a live owner but `doctor` shows no bridge and `Get-Process -Id <pid>` is an unrelated process, remove those two files from the managed home and start again. Do not remove them while a bridge process is running. The control channel is independent of the bearer credential, so after a credential rotation that left a live daemon, `stop` then `start` reconnects with the current token. If `control.key` itself is lost, restore it or stop the recorded process manually before starting; setup refuses to rotate while a live owner record cannot be authenticated.

The MCP server, CLI adapters and local test clients are verified separately from the Grok Bot UI. A real Bot-driven desktop handoff is not certified by those tests. Cloud-only execution, account limits, unavailable local permissions or an app without a supported API can still block it. The Bot's own approval system remains authoritative.

## Supervision tools

| Tool | Use |
| --- | --- |
| `agent_discover` | Find providers, model IDs, availability and owner-enrolled session imports. An empty model list defers validation to the native agent; executable availability is not authentication proof. |
| `agent_start` | Choose provider/model/directory/task and a stable requestId. Retries return the retained session; changed arguments with the same ID fail. |
| `agent_sessions`, `agent_read` | Find sessions and read redacted activity after a cursor. Check `truncated` and `earliestCursor`. Pending requests are returned explicitly. |
| `agent_respond` | Answer a request by sessionId/requestId with answer or allow. Deterministically blocked operations cannot be approved. |
| `agent_followup` | Continue a completed turn in the same native session with corrections. Repeated prompts and turn limits stop loops. |
| `agent_verify` | Run the owner-selected command and collect current Git HEAD/diff evidence. |
| `agent_finish` | Accept using the latest passing evidenceId. Changed files or HEAD invalidate that evidence. |
| `agent_cancel` | Interrupt and retain evidence/worktree. |
| `agent_resume` | Continue an interrupted or disconnected completed native session after bridge restart. Old pending approval IDs are invalid. |
| `agent_attach` | Enter an owner-enrolled existing native session by importId/task/requestId. |

`awaiting_review` means the coding agent ended a turn. It does not mean the task succeeded. The supervisor must inspect the result against the original goal, run verification, and either send a corrective follow-up or finish using the returned passing evidence ID. There is no unconditional automatic acceptance of worker claims.

## Existing sessions and other providers

Add existing sessions explicitly to owner config:

```json
{
  "imports": [{
    "id": "my-existing-session",
    "provider": "codex",
    "model": "EXACT_NATIVE_MODEL_ID",
    "nativeId": "EXISTING_NATIVE_SESSION_ID",
    "worktree": "/absolute/path/to/existing-linked-worktree"
  }]
}
```

Merge this fragment with the required stateDirectory/roots configuration. Imported worktrees must be linked Git worktrees belonging to an enrolled repository. Main checkouts and arbitrary terminal-process hijacking are unsupported. Codex validates resumed cwd; ACP requires advertised session loading; Claude uses its native `--resume`. Some providers cannot reconnect to an already-running process: stop/handoff through that provider's supported workflow first. Native ACP session loading must honor the supplied cwd. Import enrollment is a deliberate owner trust boundary.

Custom CLI adapters may be registered under `providers` with an explicit protocol:

```json
{
  "providers": {
    "custom-agent": {
      "protocol": "acp",
      "executable": "/absolute/path/to/native-agent",
      "args": ["acp"],
      "models": ["exact-model-id"]
    }
  }
}
```

Supported protocols are `acp`, `codex` and `claude`; this is an extension point, not a claim that every application speaks them. Native Grok Build and OpenCode use ACP; maintained adapters can expose Codex and Claude through ACP. Antigravity now has an official standalone ACP server that requires its own enrollment; ordinary `agy` is not the ACP entrypoint. See [connections and live results](CLI_CONNECTIONS.md). Grok Bot remains the supervisor/client. Raw interactive CLIs without structured approvals cannot receive blanket affirmative keystrokes.

To enable T3, add `t3: {"projectId":"YOUR_T3_PROJECT_ID"}` and privately set `T3_BEARER_TOKEN`. Runtime endpoint discovery uses the user's T3 runtime file; explicit endpoint/legacyEndpoint/tokenEnv overrides are owner-configurable. Issue a scoped token with `t3 auth session issue --subject mcp-client --scope orchestration:read --scope orchestration:operate --ttl 1h`. Discovery exposes IDs such as `t3:codex` and the live composer model catalog. The launch binds the explicit worktree and checks the returned model selection. T3 pending-question tools cannot approve runtime permissions; those waits report a blocker rather than being bypassed.

## Bot instruction template

Use [GROK_BOT_INSTRUCTIONS.md](GROK_BOT_INSTRUCTIONS.md) as the Bot's job description. Runtime instructions name the actual folder and requested CLI/model; this documentation is not an input dependency.

## Evidence boundaries

Policy filters intercepted operations; it is not an OS sandbox. Native tools may perform operations that never trigger an approval request. Use native sandboxing and machine/account isolation for stronger protection. Verification runs project code under owner authorization, and cannot prove that an intentionally dishonest project's tests are correct. No integration bypasses authentication, human-only account steps or Grok Bot's local-computer policy.

Tests include real local HTTP/SSE MCP calls, child-process protocol fixtures, worktree isolation, deduplication, scoped approvals, redaction, restart/import and stale-evidence rejection. Fixtures do not certify a vendor's hosted service. TestSprite credentials are available, but the CLI/MCP-only target has no frontend or public backend URL supported by its runner; no TestSprite acceptance is claimed.
