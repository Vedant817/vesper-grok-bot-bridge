# Remote access and network safety

Reviewed **23 October 2026** against Tailscale's [Funnel](https://tailscale.com/kb/1223/funnel), [Serve](https://tailscale.com/kb/1312/serve), [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve) and [ACL](https://tailscale.com/kb/1018/acls) documentation, plus the bridge's remote listener and configuration code. This guide covers the network path to the bridge. Provider account rules are in [provider policy](PROVIDER_POLICY.md); the CLIProxyAPI decision is in [the CLIProxyAPI assessment](research/CLIPROXYAPI.md).

## The boundary

The standalone bridge listens only on `127.0.0.1`. HTTPS is terminated by an owner-controlled tunnel or reverse proxy, which forwards to that loopback port. Remote MCP clients enroll through the bridge's OAuth/PKCE flow with local owner approval; every `/mcp` request requires an authorized bearer credential. The bridge checks Host against the configured HTTPS origin (including any port) or the exact loopback endpoint, and checks any supplied Origin header against the configured origin. OAuth discovery and enrollment endpoints remain publicly reachable. A VPN, tailnet or tunnel can protect the path, but it cannot replace those controls or authorize a provider account. The bridge is single-owner, not multi-tenant.

```text
Grok Bot cloud -- HTTPS --> T3 Connect relay --> T3 host
Grok Bot cloud -- HTTPS --> owner tunnel / Tailscale Funnel --> 127.0.0.1 bridge
Owner device  -- tailnet HTTPS --> Tailscale Serve --> 127.0.0.1 bridge
Owner admin   -- tailnet SSH --> host (separate administration path)
```

T3 Connect is the supported remote path for T3 sessions. The standalone CLI route needs an owner-provided HTTPS ingress; Tailscale is one optional way to provide it.

## Choose the route

| Need | Route | Internet exposure | Primary access control |
| --- | --- | --- | --- |
| T3 sessions from Grok Bot's cloud | [T3 Connect](T3_CONNECT_QUICKSTART.md) | Internet-reachable HTTPS, OAuth-gated | T3 OAuth and T3 session permissions |
| Standalone bridge from Grok Bot's cloud | Owner HTTPS tunnel, reverse proxy or Tailscale Funnel | Public HTTPS, bridge OAuth-gated | Bridge OAuth/PKCE, exact origin and Host checks, local approval |
| Owner device or local MCP client | Tailscale Serve, or the bridge's stdio `connect` | Tailnet-only for Serve | Tailnet ACLs plus bridge OAuth; stdio uses the local owner path |
| Host administration or multi-device shell | Tailscale SSH or [Mesh](research/MESH.md) | Tailnet-only | Tailscale SSH policy and device identity, or SSH keys and host checks for ordinary SSH; not a bot connector |

T3 Connect is not interchangeable with a generic tunnel. `localhost`, `127.0.0.1`, LAN addresses and private Tailscale addresses are not generally reachable from Grok Bot's cloud. Funnel is not needed for T3, and exposing T3's runtime or the bridge control channel to "fix" a connection is not supported.

## What the bridge enforces

- The remote listener binds to loopback only; it is never a LAN listener.
- The configured origin must be an HTTPS origin. The incoming Host header must match that origin's host and port, or the exact loopback host and port.
- OAuth uses PKCE and a local owner approval. The owner bearer credential is separate from native provider credentials.
- Every MCP request is authenticated; bodies and sessions are bounded. OAuth discovery, registration and authorization endpoints are publicly reachable as required for enrollment; owner approval endpoints require a separate signed local request.
- `remote status` reports configuration, protected credential availability, daemon state and local runtime. Its `publicReachability: not_checked` field is deliberate: it does not prove that a tunnel is reachable, healthy or public.

A tunnel must preserve these controls. If a tunnel rewrites the public Host to a different host or port, configure the bridge with the exact public origin or use the supported loopback rewrite; do not disable Host or Origin checking to make the tunnel work.

## Tailscale Funnel: public ingress for the standalone bridge

Tailscale Funnel exposes a local service to the internet at a unique tailnet HTTPS URL. It is currently beta, available on all plans, TLS-only, and limited to public ports **443, 8443 and 10000**. Traffic is subject to non-configurable bandwidth limits. Funnel requires HTTPS certificates for the tailnet and a `funnel` node attribute in the tailnet policy file.

The public hop is encrypted. Tailscale's Funnel relay cannot decrypt the traffic; the local Tailscale client terminates TLS and forwards the request to the loopback service. Funnel traffic does **not** carry Tailscale Serve identity headers. The public URL is reachable by anyone; tailnet ACLs do not gate public callers. The `funnel` node attribute controls who may create a Funnel, not who may call it. The bridge's OAuth is the gate for callers.

### Before starting

1. Confirm Tailscale is installed and authenticated. Funnel requires HTTPS certificates and a `funnel` node attribute; Tailscale's supported enable flow provisions the certificate and updates the policy when approved. Follow that flow rather than copying a policy from an unrelated tailnet.
2. Choose one public port: 443, 8443 or 10000. If another Funnel or Serve listener already uses it, choose a different port or stop the other listener deliberately.
3. Check existing configuration and preserve unrelated listeners:

   ```powershell
   tailscale funnel status --json
   tailscale serve status --json
   ```

4. Stop the managed bridge before changing remote exposure. Configure the bridge with the exact URL Tailscale will print, including the port. The URL is based on the tailnet DNS name, for example `https://host.tailnet-name.ts.net:8443`; read the DNS name from `tailscale status --json`, or start Funnel first and use the URL it prints.

   ```powershell
   grok-agent-bridge stop
   grok-agent-bridge remote enable --origin https://host.tailnet-name.ts.net:8443 --port 43189
   grok-agent-bridge start
   grok-agent-bridge remote status
   ```

5. Start Funnel as a background listener and confirm the exact URL:

   ```powershell
   tailscale funnel --bg --https=8443 http://127.0.0.1:43189
   tailscale funnel status --json
   ```

   `--bg` keeps the listener across reboots and Tailscale restarts until it is turned off. Without `--bg`, the command stays in the foreground and stops when it exits. If the printed URL differs from the configured origin, stop the bridge, reconfigure the origin, and restart; do not weaken the Host check.

6. Add `https://host.tailnet-name.ts.net:8443/mcp` as the connector URL in Grok Bot. Complete OAuth in the browser, then approve the exact pending request locally. Replace `EXACT_PENDING_REQUEST_ID` below with the ID returned by `remote pending`:

   ```powershell
   grok-agent-bridge remote pending
   grok-agent-bridge remote approve EXACT_PENDING_REQUEST_ID
   grok-agent-bridge remote clients
   ```

7. Run a bounded read-only task before trusting the route with a repository-changing task. Confirm the response, the exact session IDs and the verification evidence.

### Funnel security checklist

- Treat the URL as internet-facing. Anyone can reach it; only the bridge's OAuth and local approval decide who gets in.
- Narrow the `funnel` node attribute. Tailscale's default grants Funnel use to `autogroup:member`; replace that with the specific tag (preferred) or a narrower group that should run the bridge, so unrelated tailnet members cannot create public listeners. Tailscale's ACL documentation covers the policy syntax.
- Map only the bridge's loopback port. Do not expose the managed control channel, provider authentication files, T3 runtime, SSH/RDP, a proxy management API, or a general shell.
- Do not run Serve and Funnel on the same port. Tailscale does not allow it, and the most recent command wins. Re-check both status commands after any change.
- Keep `remote diagnostics`, client lists and logs free of tokens, authorization codes and task content.
- Revoke clients that are no longer used, and disable remote access when it is not needed.
- Funnel is beta and bandwidth-limited. Do not use it for high-volume work, availability-critical automation, or as a substitute for T3 Connect on T3.

## Tailscale Serve: tailnet-only access

Tailscale Serve exposes a local service only to devices on the tailnet. Tailnet ACLs and grants apply, HTTPS certificates are required, and Serve adds Tailscale identity headers for tailnet traffic (not for Funnel, and not for traffic from tagged devices). This bridge does not consume those headers, so Serve does not replace its OAuth; the bridge still authenticates and asks the owner to approve the client.

Serve is useful for an owner's phone, laptop or another local MCP host on the tailnet. It is not a route from Grok Bot's cloud: private Tailscale addresses are not generally reachable there. For a local client on the same host, prefer the bridge's stdio `connect` command; for a tailnet device, Serve can provide HTTPS, but the bridge's remote configuration still applies.

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:43189
tailscale serve status --json
```

Do not switch an existing Funnel port to Serve while the Grok Bot connector depends on it: the bot will lose access because the address is no longer public. The bridge has one configured origin. Choose one remote route for the bot, and use stdio for local clients. If you need two remote origins, use separate bridge enrollments; a reverse proxy that changes the public origin will not preserve the OAuth metadata and Host checks.

Grant only the intended users or devices access to the bridge host and port. Avoid broad `autogroup:member` rules for a service that can start coding work. Tailscale identity headers are an additional signal for services that consume them; they are not consumed here, so do not assume they authenticate the bridge.

## Other HTTPS tunnels and reverse proxies

Cloudflare Tunnel, ngrok, a VPS reverse proxy and similar services follow the same rules:

- Use a stable HTTPS URL. Ephemeral URLs require reconfiguring both the bridge and the connector.
- Configure the exact origin, including a non-default port. Preserve the public Host header or rewrite it to the exact loopback host and port the bridge accepts.
- Disable request and body inspection. Authorization headers, task content and verification evidence are sensitive.
- Keep tunnel credentials in the tunnel's native store, never in command arguments, chat, templates or logs.
- Keep the bridge's OAuth and local approval in place. A tunnel's own access page or SSO does not replace them unless you have verified that it forwards the complete OAuth flow and preserves the exact origin.
- Do not expose the control channel or provider CLIs alongside `/mcp`.

## What not to expose

- The managed control channel, named pipe, `control.key` or owner credential.
- `remote-credential.bin`, bearer tokens, OAuth codes or approval URLs.
- T3's runtime, desktop or private Connect credentials.
- Provider authentication files, CLIProxyAPI's management API, or any credential-pooling gateway.
- SSH, RDP, VNC, a general terminal or Mesh `exec` as the bot connector.
- The bridge on `0.0.0.0` or a LAN interface. Do not "fix" a tunnel by changing the bind.

## Monitoring and rollback

- `grok-agent-bridge remote status` shows the configured endpoint, credential availability, daemon state and local runtime. It does not test public reachability.
- `remote clients` lists authorized clients; `remote pending` shows outstanding approvals; `remote diagnostics` retains sanitized observations.
- Revoke a client with `remote revoke <client-id>`.
- Stop the bridge and run `remote disable` to remove remote exposure. Disabling retains the protected owner credential; it is not credential rotation.
- Turn off the background Funnel listener above with `tailscale funnel --bg --https=8443 off`; preserve the original flags if you used a different configuration.
- Turn off the background Serve listener above with `tailscale serve --bg --https=8443 off`; preserve the original flags if you used a different configuration.
- Prefer these port-specific `off` commands. Either `tailscale funnel reset` or `tailscale serve reset` clears the shared Serve/Funnel configuration, including unrelated public and private services. Use either reset only when you intend to remove all of that configuration on the host.
- `--bg` listeners persist until turned off; foreground listeners stop when the command exits or the host reboots.
- After a rollback, re-check `remote status`, `tailscale funnel status --json` and `tailscale serve status --json`. Confirm that no unintended public listener remains.
- If the owner credential itself may have leaked, stop remote access, revoke affected clients, and treat the host as compromised. There is no CLI key-rotation command yet; `remote disable` retains the credential, so see [standalone administration](STANDALONE.md) and follow the platform credential-store recovery guidance before re-enabling.

## Limits

- Funnel is beta, bandwidth-limited, and dependent on DNS/certificate propagation. It has no availability guarantee.
- Funnel requires a platform that can run the Tailscale CLI. On macOS, capabilities differ by Tailscale application variant and by whether you share ports or files; check the current platform requirements for the selected variant.
- `remote status` is local state, not a public reachability probe.
- Tailscale is optional. This repository does not install, configure or require it, and no live Funnel/Serve listener was created for this review.
- Tailscale protects the network path. It does not change provider account rules, quotas or subscription permissions. Read [provider policy](PROVIDER_POLICY.md) and [the CLIProxyAPI assessment](research/CLIPROXYAPI.md) before treating a tunnel as an account-safety measure.
- This guide is source-reviewed engineering guidance, not a penetration test or a legal opinion.

## Sources

- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)
- [`tailscale funnel` command](https://tailscale.com/docs/reference/tailscale-cli/funnel)
- [`tailscale serve` command](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale ACLs](https://tailscale.com/kb/1018/acls)
- [T3 Connect setup](T3_CONNECT_QUICKSTART.md)
