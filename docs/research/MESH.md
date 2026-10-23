# Hona/mesh assessment

Reviewed 22 October 2026: [repository](https://github.com/Hona/mesh), [design specification](https://github.com/Hona/mesh/blob/main/SPEC.md), [MCP implementation](https://github.com/Hona/mesh/blob/main/src/mcp/mod.rs), and [SSH implementation](https://github.com/Hona/mesh/blob/main/src/transport/ssh.rs).

Mesh can complement this bridge for enrolled devices connected through Tailscale and SSH. Its one-time setup, fixed local state paths, device health reports, and startup management address similar operational problems. Its MCP interface exposes `status` and general `exec`; the SSH configuration enforces host-key checking and noninteractive authentication.

It does not supply this bridge's task identity, native coding-session ownership, exact model selection, review/verifier gate, or human-only escalation. General remote execution must not become an alternate route around those controls. Its specification explicitly excludes automated tests and backward compatibility before 1.0; that acceptance model differs from this project's requirements.

Keep T3 Connect for T3 sessions. Consider Mesh as a separately enrolled transport for a future remote bridge: deploy the bridge on each target, preserve its local worktrees/policy/credentials, and expose only scoped bridge operations through the remote route. Do not proxy raw CLI credentials or automatically replay disconnected commands.

## Network and account boundary

Mesh's Tailscale and SSH transport is an administration path, not a provider-account or MCP authorization layer. Tailscale Serve/Funnel and other tunnels are compared in [remote access and network safety](../NETWORK_SECURITY.md). CLIProxyAPI-style account pooling is assessed in [the CLIProxyAPI review](CLIPROXYAPI.md) and is not integrated. Mesh's general `exec` must not be used as a bot connector or to bypass the bridge's task identity, approvals or verification.

No Mesh installer, SSH server, device enrollment, remote execution, Tailscale Serve/Funnel listener, or global OpenCode instruction changes were performed. This is source research, not interoperability acceptance; Mesh is not a runtime dependency of this release.

The owner chose to prioritize this computer. One immediately useful design lesson is discovering installed tools beyond PATH. The bridge now checks T3 Desktop's public Windows launcher at `~/.t3/bin/t3.cmd` after explicit runtime hints and a native PATH executable. It extracts only a recognized native T3 executable and its sibling bundled entrypoint, checks the executable/archive files, and never executes the shell shim. This removes a manual launcher-path setting on ordinary T3 Desktop installations. Bot MCP approval is still a separate one-time human step.
