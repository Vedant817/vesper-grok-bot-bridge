# Background coding CLIs without T3 Code

The wrapper launches installed native CLI processes in the background. ACP carries prompts, streamed responses, offered permission choices, cancellation and explicit session continuation. Codex can also use its native app-server adapter. A visible terminal and T3 Code are not required. The coding host must remain awake, online and signed in, with the managed bridge and chosen CLI authentication available.

Add the Vesper — CLI through Grok Bot Marketplace or its genuine shared link when published; this repository currently has no public template URL. Then install the MCP runtime below. The [template source kit](../community/cli/README.md) is for publishers/manual setup, not a required marketplace-user download. [Compare the T3 route](ROUTES.md) and read [provider/account requirements](PROVIDER_POLICY.md) before choosing authentication or offering hosted use.

Grok Bot's command MCP connectors execute on its cloud computer, according to the installed application's connector description and its capability response. Installing a local stdio server does not connect that cloud computer to Windows. Use the standalone authenticated HTTPS gateway below. Local MCP hosts can use `grok-agent-bridge connect` over stdio directly.

## Install once

Requires Node.js 22+, Git and a supported installed CLI. Build the package as described in [distribution](DISTRIBUTION.md), install it, then enroll a trusted repository with its real verifier:

```powershell
npm install -g ./grok-bot-mcp-agent-0.1.0.tgz
grok-agent-bridge setup --repository C:/Code/my-project
grok-agent-bridge provider list
```

The managed per-user daemon persists paths and uses sign-in startup. Worker authentication remains in each native provider's store. Neither an xAI API key nor T3 credentials are needed for this path.

Enroll an installed ACP adapter using its absolute native executable and argument array. See [CLI connections](CLI_CONNECTIONS.md). The owner selects exact model IDs; there is no silent provider/model substitution. Enrollment probes initialization only, which does not prove login or inference readiness.

## Remote HTTPS enrollment

First finish or cancel active work, then stop the bridge. Choose an HTTPS origin controlled by you and a private loopback port. Arrange a supported HTTPS tunnel/reverse proxy to forward that origin to this port. Its upstream must preserve the public Host header or rewrite it to the exact loopback host and port. Disable request/body inspection in the tunnel; authorization headers and task contents are sensitive.

```powershell
grok-agent-bridge stop
grok-agent-bridge remote enable --origin https://your-public-host.example --port 43189
grok-agent-bridge start
grok-agent-bridge remote status
```

Optional owner-selected native tunnel processes can be started/stopped with the daemon by adding `--tunnel-command C:/absolute/tunnel.exe --tunnel-args '["..."]'` during enrollment. Keep credentials in the tunnel's native store, never its arguments. There is no automatic tunnel retry. A persistent external tunnel service is also supported. Choose a stable public URL; an ephemeral URL requires reconfiguration of both gateway and connector.

For an already authenticated Tailscale installation, **Funnel** can provide the public HTTPS origin. Funnel is public internet exposure, not a private tailnet service; Tailscale's Funnel relay cannot decrypt the traffic, but anyone can reach the URL, so the bridge's OAuth, Host/Origin checks and local approval remain the access controls. **Serve** is tailnet-only and is not a substitute for the Grok Bot cloud connector; private Tailscale addresses are not generally reachable from Grok Bot's cloud. Check `tailscale funnel status --json` first, preserve other listeners, and use the exact HTTPS origin printed by the native tool, including its port. Do not run Serve and Funnel on the same port; the most recent command wins. See [remote access and network safety](NETWORK_SECURITY.md) for the decision table, commands, ACL guidance and rollback. Follow [Tailscale's supported Funnel setup](https://tailscale.com/docs/reference/tailscale-cli/funnel).

In Grok Bot, add a **Remote HTTPS MCP connector** pointing to `https://your-public-host.example/mcp` and choose OAuth. The gateway implements public client registration and PKCE S256 through the official MCP SDK. Its authorization page displays the unverified client name and exact callback, then waits for approval on the coding computer. No credential needs copying into Grok Bot or conversation.

Inspect the request locally, confirm that its client and callback match the connection you initiated, then approve its exact request ID:

```powershell
grok-agent-bridge remote pending
grok-agent-bridge remote approve EXACT_PENDING_REQUEST_ID
grok-agent-bridge remote clients
```

Approval grants `coding:operate` for the enrolled bridge: it can operate the owner-enrolled repositories and providers. Only approve a connector you intended to control them. Authorization requests expire after five minutes, codes after 60 seconds, and approved access tokens after 30 days. There are no refresh tokens; repeat approval after expiry. Temporary client registrations expire rather than permanently consuming approved-client slots. Approved client identities and revocations persist across daemon restart; tokens are signed and bound to this gateway's exact resource and client. Native MCP sessions cannot be borrowed by a different OAuth client.

Revoke a connector with `grok-agent-bridge remote revoke EXACT_CLIENT_ID`. Stop the bridge and run `remote disable` to disable all remote exposure. A separate local gateway owner credential is protected with CurrentUser DPAPI on Windows and private file permissions elsewhere; it authenticates local approvals without appearing in argv, chat or command output. Disabling retains that credential privately; key rotation is not yet a CLI feature.

For other clients that can safely store private Authorization headers, Windows `remote copy-token` transfers the owner bearer to the OS clipboard and clears it after 60 seconds if unchanged. This is a broad owner credential: never give it to an OAuth-only connector, ordinary conversation, or an untrusted client. Clipboard history/sync follows your OS settings. Grok Bot uses OAuth instead because its masked-secret workflow cannot reference a stored secret from connector headers.

## Grok Bot instruction

### Native approval policy

OAuth enrollment does not change Grok Bot's Auto Review policy. The live connection also asked for approval on some individual connector calls, including read-only waits. The wrapper cannot remove those platform prompts, and tests that used an approved prompt are not proof of unattended execution.

Grok Bot supports personal **Allow automatically** rules in Settings → General → Auto-review. Configure narrow rules yourself if appropriate, for example allowing only `agent_discover`, `agent_sessions`, `agent_read`, `agent_monitor` and `agent_wait` on this connector. Keep writes scoped to explicitly delegated tasks and enrolled repositories. Ask-first and administrator rules take precedence; automated review can still stop a matching action. Never disguise a mutating tool as read-only or disable security review globally. Follow the [official approval controls](https://docs.x.ai/grok-bot/approvals-security-and-privacy).

Wait for each approved call to settle before sending another. In the live check, a new start was refused by the host while a previous permission card remained unresolved. Reconcile the bridge session list and retain the same request ID after a proven pre-send rejection; do not infer that a native operation failed merely because its host confirmation was interrupted.

> Use the standalone coding-agent connector. Discover providers first. Start a background ACP worker for the exact enrolled directory, provider and model I name. Save its bridge and native session IDs. Use agent_wait/agent_read to inspect events. Resolve only delegated technical questions and scoped permissions; pause for human-only authentication/security requests. Evaluate each response against my task, send corrections using agent_followup in the same session, and verify actual work with agent_verify before agent_finish. Respect quota and model errors. Never replay uncertain starts, rotate accounts, increase budgets, or choose another model without instruction. Cancel the session when a bounded connection test is complete.

`remote status` distinguishes configuration, protected credential availability, local daemon state and startup observation. `listening` and `tunnel:started` mean local initialization/startup survival, not public reachability or continuous tunnel health. After a network/tunnel failure, reconcile the original worker; do not resubmit its task. The remote HTTP endpoint has bounded bodies/sessions and authentication on every request, but does not provide an OS sandbox or multi-user authorization.

If enrollment fails before the approval page, use `remote diagnostics` locally. It retains at most 32 sanitized observations: route/status and allowlisted registration preferences, never raw request bodies, query values, headers, codes or tokens. Registration negotiates the supported public-client metadata even if a hosted client requests secret authentication or refresh tokens; the response still grants neither, and authorization still requires PKCE and local approval.

## Evidence and limits

Repository tests exercise real SDK HTTP discovery/calls, malformed authentication and Host/Origin boundaries, separate credentials, daemon restart and cancellation during remote startup. Windows tunnel fixtures verify owned process-tree cleanup. They do not establish live public reachability or Grok Bot enrollment.

The final serial suite passed **369 tests across 35 files** (one platform-gated skip), with strict TypeScript checks and build passing. A hosted TestSprite backend run passed the public endpoint's authentication, metadata, unsafe callback, unknown-client, owner-route and Origin checks. It received no private keys, worker prompts or native credentials and does not certify authenticated worker supervision or reboot behavior.

On 23 October 2026, the installed Grok Bot completed OAuth enrollment against this gateway and performed two-turn response review through standalone background Codex ACP, Antigravity ACP and free Cline ACP sessions. Each incorrect draft was corrected in the same native session. OpenCode's free model reported its usage limit and was cancelled; Grok Build's previously established balance failure was not retried. All four new response-probe sessions were cancelled with clean worktrees. Claude was excluded at the owner's request. See [the provider matrix](CLI_CONNECTIONS.md#standalone-grok-bot-results-23-october-2026).

These live calls used individual native Grok Bot approval prompts. They establish assisted connector/session control, not fully unattended acceptance. Scheduled startup is configured on the tested Windows host; physical reboot, app-closed operation and non-Windows startup remain unverified.

The separate Codex coding exercise completed two turns: a deliberately wrong implementation failed the immutable verifier, Grok Bot corrected the same native session, and verification passed one test covering five inputs. Only the implementation file changed. Grok Bot then called `agent_finish` with the current passing evidence; an independent read confirmed `finished`, no pending input and the unchanged native session ID.

After an explicit daemon stop/start, Grok Bot successfully read the enrolled provider catalog and retained finished evidence without reconnecting or repeating OAuth approval. A read overlapping startup first failed with a transport error; once the daemon was healthy, a read-only retry succeeded. Availability errors during startup do not authorize replaying mutations. This restart check does not establish physical reboot acceptance.
