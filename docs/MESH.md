# Hona/mesh assessment

Reviewed 22 October 2026: [repository](https://github.com/Hona/mesh), [design specification](https://github.com/Hona/mesh/blob/main/SPEC.md), [MCP implementation](https://github.com/Hona/mesh/blob/main/src/mcp/mod.rs), and [SSH implementation](https://github.com/Hona/mesh/blob/main/src/transport/ssh.rs).

Mesh can complement this bridge for enrolled devices connected through Tailscale and SSH. Its one-time setup, fixed local state paths, device health reports, and startup management address similar operational problems. Its MCP interface exposes `status` and general `exec`; the SSH configuration enforces host-key checking and noninteractive authentication.

It does not supply this bridge's task identity, native coding-session ownership, exact model selection, review/verifier gate, or human-only escalation. General remote execution must not become an alternate route around those controls. Its specification explicitly excludes automated tests and backward compatibility before 1.0; that acceptance model differs from this project's requirements.

Keep T3 Connect for T3 sessions. Consider Mesh as a separately enrolled transport for a future remote bridge: deploy the bridge on each target, preserve its local worktrees/policy/credentials, and expose only scoped bridge operations through the remote route. Do not proxy raw CLI credentials or automatically replay disconnected commands.

No Mesh installer, SSH server, device enrollment, remote execution, or global OpenCode instruction changes were performed. This is source research, not interoperability acceptance; Mesh is not a runtime dependency of this release.
