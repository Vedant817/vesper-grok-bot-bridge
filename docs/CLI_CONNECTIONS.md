# Coding CLI connections: MCP outside, ACP or native APIs inside

Grok Bot remains the supervisor. A coding CLI becomes a worker through a supported session protocol; it is not made controllable merely by adding an MCP server to that CLI. MCP exposes tools to a caller; ACP runs coding sessions, streams updates, and asks the client about permissions. Codex app-server is another supported worker interface.

## Standalone CLI control

Use the [standalone guide](STANDALONE.md) to launch background CLI processes through ACP or Codex app-server without T3 installed. Grok Bot reaches the wrapper through its own authenticated HTTPS/OAuth gateway. Local MCP clients can use the installed stdio proxy. The wrapper's older loopback-only HTTP endpoint remains private; use the separate remote gateway for public HTTPS.

## Optional existing T3 connector

```text
Grok Bot native t3-connect MCP tools
                 ↓
       T3 on the coding host
                 ↓
   Codex / Claude / Grok Build / OpenCode / Antigravity
```

Use [the native T3 setup](T3_CONNECT_QUICKSTART.md) once. Grok Bot selects a provider and exact model from `orchestrator_capabilities`, then creates or continues a thread through the same connection. A separate connector per coding CLI is not needed. T3 owns its provider installation, authentication, and protocol adapters. Native provider login remains a separate requirement.

### Environment exposure

Two exposures of the T3 Connect flow are accepted by design:

- The access token reaches the T3 launcher child through the `T3_ACP_MCP_AUTHORIZATION` environment variable (the documented T3 bridge contract). Environment blocks are readable by same-user processes and inherited by descendant processes.
- `T3_ACP_MCP_NODE` and `T3_ACP_MCP_ENTRYPOINT` are honored as an ACP fallback launcher. Whoever controls the daemon's environment selects that binary.

The standalone bridge below operates independently from this T3 route. Authentication and acceptance results for the two routes must be reported separately.

## Supported interfaces

| Worker | Interface | Enrollment boundary |
| --- | --- | --- |
| Codex | Built-in app-server; optional maintained `@agentclientprotocol/codex-acp` | Native Codex login; ACP adapter wraps app-server rather than replacing it. |
| Claude Code | Existing stream-JSON adapter; optional `@agentclientprotocol/claude-agent-acp` built on Claude Agent SDK | Installed/authenticated CLI or supported SDK credentials under the provider's documented deployment terms. Adapter handshake is not proof of login. |
| Grok Build | Native ACP: `grok --permission-mode default agent --no-leader stdio` | Existing native login through advertised `cached_token`; never enable always-approve. Distinct from the Grok Bot application. |
| OpenCode | Native ACP: `opencode acp` | OpenCode's underlying provider authentication and permissions. |
| Antigravity | Official Google standalone `agy_acp_server` | Separate ACP server installation/authentication; ordinary `agy` CLI is not the ACP entrypoint. T3 can manage its own server/profile. |
| Other agents | Owner-enrolled ACP v1 executable | Must pass initialization and support the actual requested session/model capabilities. Unsupported protocols fail visibly. |

Do not copy T3's private provider profiles, tokens, or signing files into the bridge. No provider/model/account substitution is used to work around authentication, quota, or policy failures.

## One-time standalone ACP enrollment

First install the [optional bridge package](DISTRIBUTION.md) and run its ordinary setup for your repository. Install an ACP server from its publisher's documented distribution. There is no auto-download from an untrusted registry at task execution time.

For example, on Windows the two maintained adapters tested here were installed separately from the checkout and global clients:

```powershell
$adapterHome = Join-Path $env:LOCALAPPDATA 'GrokAgentBridge/adapters/acp'
npm install --prefix $adapterHome --ignore-scripts --no-audit --no-fund --save-exact @agentclientprotocol/codex-acp@2.2.2
```

This is a reproducibility pin checked 22 October 2026, not a promise that it remains the newest or appropriate version indefinitely. Review updates deliberately. `--ignore-scripts` skips package lifecycle scripts; it does not sandbox code when you later launch it. The Codex adapter includes a compatible Codex dependency; its documented `CODEX_PATH` option selects a different native binary. No credentials are passed through that option. For programmatic deployments, review the [API-key/enterprise authentication guidance](PROVIDER_POLICY.md) rather than assuming a subscription login grants every automation use.

Claude is optional and excluded from model-turn acceptance here. Before installing an SDK-backed Claude ACP adapter, review [the separate Anthropic SDK and native-product requirements](PROVIDER_POLICY.md). Do not market Claude.ai subscription login as this integration's entitlement. Use supported authentication for the exact adapter/deployment or obtain provider approval; initialization alone does not establish policy or account readiness.

With your bridge idle, inspect `agent_monitor`, reconcile any unfinished/uncertain sessions, and stop the bridge using its normal maintenance command. Provider enrollment refuses a running daemon; it does not kill live coding tasks to apply configuration:

```powershell
grok-agent-bridge call agent_monitor
grok-agent-bridge stop

$taskNode = (Get-Command node -CommandType Application).Source
$codexEntry = Join-Path $adapterHome 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'
$codexArgs = ConvertTo-Json -Compress -InputObject @($codexEntry)

grok-agent-bridge provider add --id codex-acp --command $taskNode --args $codexArgs
grok-agent-bridge provider list
grok-agent-bridge start
grok-agent-bridge call agent_discover
```

Choose a new stable ID for each intended provider configuration. Enrollment preserves existing providers and refuses conflicting IDs. The executable must be an absolute native executable path, with prefix arguments supplied as a JSON array; no `.cmd`, `.ps1`, shell parsing, or credentials in argv. `--models '["EXACT-MODEL"]'` optionally constrains model selection, and `--auth-method METHOD` selects an advertised native authentication method. `--home` selects a custom managed installation. Normal daily calls use the saved provider ID, model, and repository, without repeating paths or enrollment.

Enrollment performs only ACP v1 initialization, validates an explicitly selected auth method against advertised methods, and atomically saves configuration. It does not authenticate, create sessions, or make model requests. Startup authenticates only through the owner-selected advertised method, then creates or loads the exact session. Authentication failure does not trigger another session or another method. Grok Build's built-in profile selects `cached_token`; interactive native login must already have been completed.

An empty model list means the native session validates the exact requested model; it does not mean every model exists. `available:true` plus an ACP handshake is transport evidence. Discovery explicitly reports `authentication:"not_checked"`. Only a successful real turn proves execution access.

Use the official [Antigravity ACP guide](https://antigravity.google/docs/ide/extensions/zed/) and [publisher registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) to obtain/enroll its standalone server. Google's standalone ACP server was enrolled and exercised directly through the bridge, independently of T3.

## Standalone Grok Bot results, 23 October 2026

The installed Grok Bot connected through the bridge's own HTTPS/OAuth MCP gateway and launched background ACP workers. It read deliberately incorrect responses and sent corrective instructions to the same retained session. No T3 thread or visible terminal carried these tasks.

| CLI/model | Observed result |
| --- | --- |
| Codex ACP `gpt-6-luna` | Two turns; Grok Bot corrected 293 to 292. |
| Antigravity `gemini-3.8-flash-low` | Two turns; corrected 229 to 228. |
| Cline `cohere/north-mini-code:free` | Two turns; corrected 580 to 579. |
| OpenCode `opencode/glm-5.3-flash-free` | Initially usage-blocked and stopped. A later explicitly requested demo completed two turns: deliberate draft `7*8 = 55`, then same-session correction to `56`, followed by cancellation and a clean worktree. |
| Grok Build | Previously observed HTTP 402 balance exhaustion; inference was not repeated. |
| Claude Code | Excluded at the owner's request. |

The four new probe sessions were cancelled, with no pending input or worktree changes. Native Grok Bot approval cards required individual approval, including for some read calls: this is successful assisted supervision, not acceptance of fully unattended operation. These response probes do not by themselves certify file editing or repository verification. See [standalone setup and evidence](STANDALONE.md).

A separate Codex ACP coding exercise used the same gateway: Grok Bot requested a deliberate `n*n+4` draft, ran the immutable owner-configured `node --test` verifier, read its actual `4 !== 3` failure, and corrected the same native session to `n*n+3`. Reverification passed one test covering five inputs. Git evidence showed only the implementation file changed; tests and package configuration stayed unchanged. This is a small real coding/verification exercise, not certification of arbitrary repositories or other providers' editing behavior.

## Live results on this machine, 22 October 2026

Subsequent owner-authorized checks used **background CLI processes**, without T3 as transport: Codex ACP completed two turns, Cline ACP completed a turn with the free `cohere/north-mini-code:free` model, and Google's signed standalone Antigravity ACP1.4.1 authenticated via its supported personal OAuth method and created a session. Antigravity's cold initialize took about14seconds, so bounded discovery now allows up to30seconds. No provider credentials were copied from T3.

Grok Bot separately performed response-driven review through the native T3 connector: Codex and Antigravity corrected a deliberately wrong draft in the same thread; free OpenCode `opencode/glm-5.3-flash-free` needed two corrections and then returned the accepted answer. Grok Build's HTTP402 balance failure was observed and stopped without another turn. These no-edit probes had clean worktrees when checked for Codex, Antigravity and OpenCode. Claude was excluded from subsequent testing at the owner's request.

The owner authorized five isolated T3 test threads, each requesting a sentinel reply with no tools or file changes. Grok Bot initiated these through its native HTTPS MCP connector. Independent reads of their actual T3 transcripts showed:

| Provider/model | First turn | Same-thread continuation | Observed limit |
| --- | --- | --- | --- |
| Codex `gpt-6-luna` | `PROVIDER_CONNECTION_READY` | `PROVIDER_CONTINUATION_READY` | Passed both turns. |
| Antigravity `gemini-3.8-flash-low` | `PROVIDER_CONNECTION_READY` | `PROVIDER_CONTINUATION_READY` | Passed both turns. |
| Claude `claude-haiku-5-5` | Failed | Not attempted | `Not logged in · Please run /login`. |
| Grok Build `grok-4.7-build-fast` | Failed | Not attempted | HTTP 402: usage balance exhausted. |
| OpenCode `openai/gpt-6.1-sol` | Failed | Not attempted | HTTP 401. |

All five retained test worktrees had clean Git status when checked. These small lifecycle probes do not certify full coding, edits, approvals, verification, cancellation, or physical reboot/mobile operation.

Separate standalone evidence:

- Codex ACP **2.2.2**: initialize, isolated session, exact `gpt-6-luna` model, two sentinel turns, and unchanged worktree passed through the bridge's generic ACP worker.
- The upgraded installed daemon then retained `codex-acp` and `claude-acp` enrollment across restart. Its authenticated MCP tools started the Codex ACP worker, observed `MCP_ACP_READY`, continued the same session with `MCP_ACP_CONTINUED`, and confirmed an unchanged worktree. The probe was cancelled afterward with `executionUncertain:false`; no repository verification/finish claim was made for a sentinel-only test.
- Claude ACP **0.94.0**: ACP v1 initialization and session-load capability advertisement passed. No successful Claude model turn was claimed.
- Installed Grok Build **1.0.62**: ACP v1 initialization, native cached-login authentication, and isolated session creation passed. Direct inference returned a generic internal error; the independent T3 run exposed the exhausted balance. No inference retries or budget changes were made.
- Installed OpenCode **2.1.1** exposes ACP. The selected provider's HTTP 401 remains an authentication blocker.

## Recovery and permissions

Log into the affected provider through its native UI/CLI or T3's provider settings, then retry only after that condition changes. Resolve quota through the account owner's normal billing/limits flow; the supervisor must not buy credits, switch accounts, or raise budgets. Do not change models to conceal a failed acceptance run.

Resume only a retained native ID when the agent advertises session loading. Do not retry a launch or prompt with an uncertain outcome. Tool permissions are selected from offered ACP option IDs; unsupported elicitation remains declined, and technical-question extensions are not assumed universal ACP methods. Native operations that never request permission are outside the bridge's interception boundary.

Transport close releases owned pipes and requests teardown of its owned live process tree. It is not proof that every native task acknowledged cancellation. Existing uncertain-execution ownership/recovery rules still apply; do not attach a second controller or replay work after an unacknowledged stop.

Sources: [ACP registry](https://github.com/agentclientprotocol/registry), [Codex ACP](https://github.com/agentclientprotocol/codex-acp), [Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp), [Grok agent mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md), [OpenCode ACP](https://docs.opencode.ai/docs/acp/), [Claude deployment/authentication terms](https://code.claude.com/docs/en/legal-and-compliance).
