# Background coding CLIs without T3 Code

The wrapper launches installed native CLI processes in the background. ACP carries prompts, streamed responses, offered permission choices, cancellation and explicit session continuation. Codex can also use its native app-server adapter. A visible terminal and T3 Code are not required. The coding host must remain awake, online and signed in, with the managed bridge and chosen CLI authentication available.

Grok Bot's command MCP connectors execute on its cloud computer, according to the installed application's connector description and its capability response. Installing a local stdio server does not connect that cloud computer to Windows. Use the standalone authenticated HTTPS gateway below. Local MCP hosts can use `grok-agent-bridge connect` over stdio directly.

## Install once

Requires Node22+, Git and a supported installed CLI. Build the package as described in [distribution](DISTRIBUTION.md), install it, then enroll a trusted repository with its real verifier:

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

For an already authenticated Tailscale installation, a separate Funnel listener can provide the HTTPS origin, for example `tailscale funnel --bg --https=8443 http://127.0.0.1:43189`. Check existing `tailscale funnel status --json` first; preserve its other listeners. Tailnet policy may require human approval. Use the exact HTTPS origin printed by the native tool, including its port. Follow [Tailscale's supported Funnel setup](https://tailscale.com/docs/reference/tailscale-cli/funnel).

In Grok Bot, add a **Remote HTTPS MCP connector** pointing to `https://your-public-host.example/mcp` and choose OAuth. The gateway implements public client registration and PKCE S256 through the official MCP SDK. Its authorization page displays the unverified client name and exact callback, then waits for approval on the coding computer. No credential needs copying into Grok Bot or conversation.

Inspect the request locally, confirm that its client and callback match the connection you initiated, then approve its exact request ID:

```powershell
grok-agent-bridge remote pending
grok-agent-bridge remote approve EXACT_PENDING_REQUEST_ID
grok-agent-bridge remote clients
```

Approval grants `coding:operate` for the enrolled bridge: it can operate the owner-enrolled repositories and providers. Only approve a connector you intended to control them. Authorization requests expire after five minutes, codes after60seconds, and approved access tokens after30days. There are no refresh tokens; repeat approval after expiry. Temporary client registrations expire rather than permanently consuming approved-client slots. Approved client identities and revocations persist across daemon restart; tokens are signed and bound to this gateway's exact resource and client. Native MCP sessions cannot be borrowed by a different OAuth client.

Revoke a connector with `grok-agent-bridge remote revoke EXACT_CLIENT_ID`. Stop the bridge and run `remote disable` to disable all remote exposure. A separate local gateway owner credential is protected with CurrentUser DPAPI on Windows and private file permissions elsewhere; it authenticates local approvals without appearing in argv, chat or command output. Disabling retains that credential privately; key rotation is not yet a CLI feature.

For other clients that can safely store private Authorization headers, Windows `remote copy-token` transfers the owner bearer to the OS clipboard and clears it after60seconds if unchanged. This is a broad owner credential: never give it to an OAuth-only connector, ordinary conversation, or an untrusted client. Clipboard history/sync follows your OS settings. Grok Bot uses OAuth instead because its masked-secret workflow cannot reference a stored secret from connector headers.

## Grok Bot instruction

> Use the standalone coding-agent connector. Discover providers first. Start a background ACP worker for the exact enrolled directory, provider and model I name. Save its bridge and native session IDs. Use agent_wait/agent_read to inspect events. Resolve only delegated technical questions and scoped permissions; pause for human-only authentication/security requests. Evaluate each response against my task, send corrections using agent_followup in the same session, and verify actual work with agent_verify before agent_finish. Respect quota and model errors. Never replay uncertain starts, rotate accounts, increase budgets, or choose another model without instruction. Cancel the session when a bounded connection test is complete.

`remote status` distinguishes configuration, protected credential availability, local daemon state and startup observation. `listening` and `tunnel:started` mean local initialization/startup survival, not public reachability or continuous tunnel health. After a network/tunnel failure, reconcile the original worker; do not resubmit its task. The remote HTTP endpoint has bounded bodies/sessions and authentication on every request, but does not provide an OS sandbox or multi-user authorization.

## Evidence and limits

Repository tests exercise real SDK HTTP discovery/calls, malformed authentication and Host/Origin boundaries, separate credentials, daemon restart and cancellation during remote startup. Windows tunnel fixtures verify owned process-tree cleanup. They do not establish live public reachability or Grok Bot enrollment.

Earlier live Grok Bot response-based supervision through T3 corrected Codex, Antigravity and a free OpenCode model; Grok Build hit its balance limit and was stopped. Direct background Codex ACP and free Cline ACP inference also passed. These are separate observations, not proof that every provider is connected through the standalone public gateway. Claude account testing was excluded at the owner's request. Live standalone results must be recorded separately.
