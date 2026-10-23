# Grok Bot + T3 Code: native MCP setup

Use Grok Bot as the supervisor and T3 Code as the coding host. Grok Bot communicates through T3's existing HTTPS MCP server. It does not click the T3 interface or run terminal commands to communicate with T3. No additional MCP server, bridge installation, or xAI API key is needed for this route.

```text
Your phone or desktop → Grok Bot → HTTPS MCP + OAuth → T3 Connect
                                                      ↓
                                            T3 host → coding agents
```

Add the published Keystone — T3 through Grok Bot Marketplace or its real template link, then follow this guide. No public template URL is currently configured by this repository. Publishers maintain its [profile and listing source](../community/t3/README.md); the source kit is not a required recipient download or a native import format. Each user connects their own environment and approves their own access. No template grants the creator's endpoint, login or credentials. See [route comparison](ROUTES.md) and [provider-policy review](PROVIDER_POLICY.md).

## 1. Prepare the coding host once

1. Install [T3 Code](https://t3.codes) on the computer where your repositories and coding agents will run.
2. Configure and authenticate your chosen coding provider in T3. Confirm it can run a normal task. A Grok Bot subscription does not install or authenticate Codex, Claude Code, or another provider.
3. Add the repository as a T3 project. Use T3's provider/model catalog to select actual installed providers and supported models.
4. Open T3 **Settings → Connections**, sign in to T3 Connect, and enable **T3 Connect**. Wait for a connected tunnel; enabling the switch alone does not prove reachability.

## 2. Obtain the public MCP URL

The URL has this shape:

```text
https://<your-environment-address>/mcp
```

For a saved remote environment, open **Settings → Connections → that environment's menu → Copy MCP URL**.

**If the menu only contains “Icon”:** you opened the local machine menu. That menu does not expose Copy MCP URL in the inspected Windows nightly. Open [app.t3.codes](https://app.t3.codes), sign in to the same T3 Connect account, connect to your host, and use the saved environment's menu in Connections. The desktop, browser, and mobile interfaces can differ by version. Do not repeatedly search the local Icon menu or assume an update will add the action there.

Use the public T3 Connect address for a cloud-hosted bot. `localhost`, `127.0.0.1`, LAN addresses, and private Tailscale addresses are not generally reachable from Grok Bot's cloud. **Create link** creates a pairing/authorization link; it is not a replacement for the MCP URL. Share only the base MCP URL, never a token, pairing code, or a URL containing an authorization secret.

Tailscale Serve is not a substitute for this route: a private tailnet address is not generally reachable from Grok Bot's cloud, and T3 Connect already provides the relay and OAuth boundary. Do not expose T3's runtime or the bridge control channel through Funnel to work around a connection problem. See [remote access and network safety](NETWORK_SECURITY.md).

## 3. Add the native connector in Grok Bot

Create or open a personal bot named, for example, **Coding Agent Supervisor**. Send:

> Add a persistent native Remote HTTPS MCP connector named t3-connect for https://YOUR-ENVIRONMENT/mcp. Use OAuth with dynamic client registration. Present the native authorization card. Do not use computer-use or terminal commands to communicate with T3. After I authorize it, discover the actual tools and list projects and providers/models read-only. Do not start or change threads yet. Never ask for tokens or pairing codes in chat.

In the tested setup, asking the bot created a native connector card even though the plugin management screen did not show an add-server button. Account, plan, administrator policy, and version can affect availability. If the bot cannot offer native custom MCP enrollment, report that limitation; do not substitute the Grok Build CLI or a terminal workaround while claiming native connectivity.

Click **Authorize** on the connector card and complete T3's OAuth approval. Confirm the environment and client are the ones you intended. Choose the permission ceiling appropriate to your tasks: **Read only** cannot create or steer threads; an operating grant such as **Supervised** can, subject to its approval requirements. T3's native permission ceiling remains authoritative. The grant can cover threads across projects, so review its scope before approving it.

No client secret needs to be copied into chat. For a personal bot, keep this a personal connector; sharing a Team Bot or publishing a template is a separate decision with different credential/access implications.

## 4. Verify before assigning real work

Ask the bot to use the connector to:

1. Discover actual MCP tools and call `orchestrator_capabilities` and `t3_project_list`.
2. Report the selected project and available exact provider/model IDs. Installation, a connected badge, or an assistant's statement alone does not prove tool access.
3. List/read threads in that project without modifying them.

Then run an explicitly isolated acceptance task:

> Using only t3-connect, create one new thread in PROJECT with PROVIDER and MODEL from the discovered catalog, in a new isolated worktree. Title it “MCP connection check”. Ask the worker to reply T3_MCP_READY and make no file changes, installs, commits, pushes, or external requests. Wait for its reply and report the actual thread ID and status. Then send a follow-up to that same thread asking it to reply T3_MCP_CONTINUED. Do not create a second thread for the follow-up. Stop afterward.

A passing run demonstrates new-thread and same-thread continuation. Test question handling and a real coding task separately. Use the [bot instructions](T3_BOT_INSTRUCTIONS.md) for ongoing supervision. Select each project's real checks; a worker saying “done” is not independent verification.

## What must remain running?

| Component | Requirement for this native HTTPS route |
| --- | --- |
| Coding host | Powered on, awake, online, with repositories and providers available. Sleep, shutdown, or lost internet prevents live control. |
| T3 backend and Connect tunnel | Must stay running and reachable. T3 Connect routes requests; it does not move your repositories or coding processes into the cloud. |
| T3 desktop on the current Windows host | Keep it running; minimizing is fine. Do not assume closing the window leaves its backend alive. An independently operated `t3 serve` host is an alternative, with its own lifecycle to manage. |
| Grok Bot desktop on the coding host | Does not need to remain open for cloud work through a native remote HTTPS connector. This differs from the optional local-terminal route. |
| Phone or other prompting device | Can be used to send tasks to the same account/bot. It does not host the coding process and need not remain awake after a cloud task starts. |
| A new Grok Bot message/active bot turn | Required for a new instruction. The connector itself is not an independent perpetual supervisor; ongoing checks need supported bot routines or an active supervision task. |

T3's inspected documentation supports user services on Linux and macOS via `t3 service install`, not Windows. Linux requires systemd user-service/lingering support; macOS requires the user to remain logged in. The service replaces the need for an open T3 desktop, not the need for an awake host. The optional bridge daemon's Windows autostart starts the bridge, not T3's backend.

This change does not modify sleep, startup, networking, or service settings. For an always-available deployment, choose an always-on host and verify its startup, reboot, provider login, and remote reconnect behavior before relying on it.

## Reconnect, limits, and recovery

- Enrollment persists; repeat setup is not needed each day. The inspected T3 MCP OAuth contract issues a 30-day bearer grant with no refresh token. Expiry, revocation, or an authorization failure requires native reapproval. T3 host cloud-token renewal is separate.
- If the host goes offline, retain the original thread ID and inspect its state after reconnecting. A failed response does not prove that a mutation did not happen. Do not blindly launch another thread or replay a non-idempotent instruction.
- `t3_pending_request_*` answers user questions. It cannot approve native permission requests. Login, MFA, CAPTCHA, payments, and human-only approvals remain human handoffs.
- Disconnect the connector and revoke its grant in T3's authorized clients to remove access. Do not revoke unrelated clients or rotate native provider credentials as a workaround.
- Never promise universal human replacement, unlimited unattended execution, account-policy immunity, or compatibility with every provider/version.

## Evidence and sources

On 22 October 2026, the supplied public endpoint returned HTTP 200 OAuth protected-resource metadata with the matching MCP resource. The installed Grok Bot presented a native `t3-connect` authorization card. The owner subsequently reported that the connection worked. That report is distinct from a captured end-to-end new-thread/continuation run; the acceptance task above remains the reproducible check for a new installation. No public kit contains that owner's endpoint or credentials.

Official Grok Bot documentation: [custom MCP transport/access](https://docs.x.ai/grok-bot/team-bots), [cloud and local computer separation](https://docs.x.ai/grok-bot/computer-and-apps).

T3 behavior was checked against the sibling repository's local main `ab6be13d438abeace7617e8d789d59cf2e880f42`: `docs/user/outside-agents.md`, `docs/user/remote-access.md`, and `docs/user/background-service.md`. The local-machine menu was also inspected in source and in the supplied Windows nightly screenshot. These contracts may change; verify against your installed version.

For other native coding CLIs outside T3, the optional `grok-bot-mcp-agent` package includes a separate bridge guide. Installing that package is not a prerequisite for this direct T3 connection.
