# Persistent supervision and T3 Connect

For Grok Bot controlling T3 directly, use the [native HTTPS MCP quickstart](T3_CONNECT_QUICKSTART.md) and [T3 bot role](T3_BOT_INSTRUCTIONS.md). T3 supplies that server; the bridge enrollment below is optional and separate from Grok Bot's native connector OAuth approval.

For other native CLIs, Grok Bot supplies the reasoning and calls this bridge through an MCP host or, if explicitly chosen, approved local terminal execution. No xAI API key is required. The bridge owns isolated Git worktrees, exact provider/model selection, durable sessions, and verification. It does not run a hidden reasoning model after Grok Bot disconnects.

## One-time T3 enrollment

First configure the T3 host using its supported `t3 connect` workflow. In T3, obtain the linked environment's HTTPS MCP URL and the desired project ID. Host cloud login and outside-agent MCP approval are separate. T3's Windows background-service installer is unsupported in the inspected main branch; keep the T3 desktop/server available using its supported startup options.

After the bridge's ordinary `setup`, run:

```powershell
grok-agent-bridge t3-connect login --endpoint https://YOUR-ENVIRONMENT/mcp --project-id YOUR-PROJECT-ID
grok-agent-bridge t3-connect status
grok-agent-bridge call agent_discover
```

Approve the new MCP client in the browser. This is the one human enrollment step. No token is copied into a terminal, chat, configuration, or Git. The bridge uses public dynamic client registration and authorization code with PKCE, checks state and issuer on its loopback callback, and rejects cross-origin discovery/token redirects. Its credential reference is an endpoint-bound hash, not a token. On Windows the credential is encrypted with CurrentUser DPAPI inside an owner-only directory. Native CLI credentials remain in each CLI's native store.

Enrollment persists the selected project and endpoint in the managed owner configuration, preserving enrolled repositories and verifiers. `--home <folder>` selects a custom managed installation for both commands. An unverifiable daemon owner blocks enrollment. A running bridge is restarted only after approval succeeds; a failed configuration restart restores the prior owner configuration. A successful enrollment can remain in the private store even if later configuration publication fails.

The transport prefers T3's official `acp-mcp-bridge`, using public T3 runtime hints, an installed native PATH executable, or the recognized Windows T3 Desktop launcher at `~/.t3/bin/t3.cmd`. The desktop shim is read as data to discover the native executable and sibling archive entrypoint; its shell text is never executed. An explicit native launcher can be selected once with `--bridge-command <executable>` and optional `--bridge-args '["entrypoint.mjs"]'`. Arguments are an executable prefix; the bridge appends the command and supplies authorization only through its child environment. If no official launcher is available, it uses the official MCP SDK over HTTPS. A selected launcher's failure is reported, without silently trying a different authentication path.

The inspected T3 contract issues a 30-day MCP session and no refresh token. It survives boots, but expiration, revocation, or HTTP 401 requires another browser approval. T3 Connect's cloud token refresh does not renew this MCP session. `status` reads enrollment/expiry evidence; `agent_discover` exercises the connection. Neither proves a successful coding turn. Server approval ceilings and genuine human permission surfaces remain authoritative. T3 pending-request tools answer questions; they cannot approve native permission requests.

## Task routing and the supervision loop

Give each independent user task a stable `taskKey`. Use the exact provider/model from `agent_discover`, the enrolled source directory, and a fresh `requestId` for each intended instruction. Retain a request ID across retries of that instruction. For example, save the following as `task.json`:

```json
{
  "taskKey": "project-login-fix",
  "requestId": "login-first-instruction",
  "provider": "codex",
  "model": "EXACT-DISCOVERED-MODEL",
  "directory": "C:/work/project",
  "instruction": "Implement the login fix and verify the acceptance criteria.",
  "intent": "auto"
}
```

```powershell
grok-agent-bridge call agent_dispatch @task.json
grok-agent-bridge call agent_monitor
```

| Existing binding | Dispatch behavior |
| --- | --- |
| Absent, `auto` or `new` | Create an isolated worktree and session |
| Absent, `continue` | Require an explicit session selection |
| Running or awaiting input | Return existing state; `instructionSubmitted:false` |
| Completed turn awaiting review | Continue the live worker or resume the retained native ID |
| Interrupted | Explicitly resume the retained native ID; no new task |
| Failed, cancelled, finished | Return state for inspection; do not silently restart |
| Uncertain continuation acknowledgement | Refuse replay, including after bridge restart |

Provider, model and canonical directory must match the binding. A new independent task needs a new key. Select an owner-enrolled imported session with `agent_attach`, then use its returned `sessionId` to bind it with `agent_dispatch`. The bridge does not guess the latest unrelated conversation or attach to arbitrary terminal processes.

Dispatch receipts persist before native mutations. Concurrent requests serialize; repeat IDs return the original session. A prepared start is reconciled against its retained bridge request ID and exact original fingerprint. An unresolved operation blocks further dispatches for that task, including new request IDs, and blocks direct start/attach/respond/follow-up/resume tools. Independent routed tasks remain available. A continuation with uncertain delivery is never replayed automatically; owner reconciliation of the original native session and receipt is required while the bridge is stopped. Known pre-send validation rejections are retained as rejected receipts; corrected input may use a fresh request ID. Routing records are bounded at 1,000 bindings/receipts and fail closed at capacity; archive them only with the bridge stopped, preserving receipts for requests that might still be retried.

The caller repeatedly:

1. Calls `agent_wait` with the returned session ID and cursor, waiting at most 30 seconds per call. MCP cancellation stops this wait, not the coding task.
2. Uses `agent_read` for activity and `agent_monitor` for actionable state. Stale activity produces a warning, not a fabricated failure. Legacy sessions with no activity timestamp remain unknown.
3. Answers technical questions and scoped permissions only within the user's delegated authority. Credentials, MFA, CAPTCHA, login approval, and payment confirmation require the native human handoff. Provider-withdrawn requests disappear from pending state.
4. Reviews each completed turn against the original requirements. Runs `agent_verify`; sends a concrete correction through a fresh dispatch request if needed. Never interprets worker completion as accepted work.
5. Calls `agent_finish` only with passing, unchanged verification evidence. Reports retained worktree, exact model, result and limitations. No automatic merge or push occurs.

`agent_monitor` classifies redacted failures as authentication, rate limit, quota, context, transport, policy, or unknown. These are diagnostic hints, not authorization to retry. Resolve authentication through native login. Respect documented resets and owner budgets. Do not rotate accounts/keys, buy credits, increase permissions, change models, or replay an uncertain mutation to get around a failure. Failed sessions keep native IDs and worktrees for inspection; automated recovery from terminal provider failures is not implemented.

Unacknowledged shutdown retains a durable `executionUncertain` ownership marker. Cancel cannot clear it or report ordinary completion, resume/finish are blocked, and an import cannot attach another controller to the same native session or worktree. The owner must reconcile the native process and retained state; silence or a missing local worker reference is not proof that execution stopped.

## Supported boundaries and current evidence

Research checked 22 October 2026. T3 source evidence is pinned to sibling local main `ab6be13d438abeace7617e8d789d59cf2e880f42`, especially `docs/user/outside-agents.md`, `docs/operations/connect-setup.md`, `McpOAuth.ts`, and `AcpMcpStdioBridge.ts`. The unrelated sibling checkout was not changed.

The requested [Hona/mesh assessment](research/MESH.md) treats it as a possible remote transport companion. It is not installed or used to bypass this bridge's session and permission boundaries.

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) provides explicit threads, resume, events, approvals and cancellation. [ChatGPT authentication integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) has deployment restrictions; a local open-source integration does not authorize a hosted credential proxy.
- [Claude headless CLI](https://code.claude.com/docs/en/headless) and [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) provide supported automation. This repository still uses a handwritten bidirectional CLI control adapter; public SDK migration and installed-version compatibility remain unverified. Unsupported question batches/multiselect escalate rather than inventing an answer. Follow [Claude compliance guidance](https://code.claude.com/docs/en/legal-and-compliance) for the actual deployment/authentication mode.
- [OpenCode ACP](https://opencode.ai/docs/acp/) and the [ACP turn/cancellation contract](https://agentclientprotocol.com/protocol/v1/prompt-turn) support explicit native sessions. A prompt is no longer cut off by the ordinary 120-second RPC timeout; cancellation has a bounded grace period. OpenCode's [native permissions](https://opencode.ai/docs/permissions/) remain part of the execution boundary; the bridge cannot intercept operations the provider never asks it to approve.
- [Grok Bot security and approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy) governs local execution and human takeover. Current [Team Bot documentation](https://docs.x.ai/grok-bot/team-bots) describes custom MCP transports, and this session observed a native Remote HTTPS connector authorization card for T3. The older research did not establish this route. Use the native quickstart for T3; the cloud still cannot reach a host-only localhost bridge. A Command transport's execution location must be verified rather than assumed to be the Windows host.

Repository tests, disposable protocol fixtures, real temporary DPAPI storage, and installed-daemon checks are separate evidence. OAuth browser approval against a live T3 Connect environment, Grok Bot desktop supervision, a full sign-out/reboot, and every provider/version combination require their own acceptance run. Supported interfaces and conservative limits reduce integration risk; they do not guarantee account-policy compliance for every usage or immunity from restrictions.
