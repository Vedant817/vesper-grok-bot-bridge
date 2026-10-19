# Protocol references

Reviewed 2026-10-19. Installed MCP SDK 1.32.1 supports both requested protocol versions. The lockfile pins the installed dependency graph. TypeScript is pinned to 5.9.3 for its stable AST API; version 7 no longer exports that API from the package root.

- [MCP 2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): Streamable HTTP, sessions, protocol negotiation, SSE fallback and Origin validation.
- [MCP 2024-11-05 transports](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports): legacy SSE/message POSTs. Framing is handled by the official SDK.
- [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn): initialize/new/prompt/update/permissions/cancel. session/turn and notifications/elicitation are not assumed standard wire methods.
- [ACP elicitation](https://agentclientprotocol.com/protocol/v1/elicitation): elicitation/create, explicit mode capabilities, form review and URL consent. This autonomous client does not advertise these capabilities and declines unsolicited requests. _supervisor/ask_question is explicitly nonstandard.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server): native framing, initialize/initialized, thread/start, turn/start, active-turn notifications, approvals, questions and turn/interrupt. Fixtures do not certify every installed release.
- [xAI text generation](https://docs.x.ai/developers/model-capabilities/text/generate-text): Responses endpoint, input/completion format and store:false. Model availability and account access must be configured.

## T3 observed contract

The current app-owned catalog and local T3 source were read. Runtime JSON contains version, host/port and origin; the live /mcp endpoint returns 401 without credentials. Discovery supports version-1 origin -> /mcp plus explicit mcpUrl/mcp.url.

Observed lifecycle tools: t3_thread_launch, t3_thread_wait, t3_thread_read, t3_pending_request_list/read/respond, t3_thread_send and t3_thread_interrupt. Pending requests expose questions only and cannot approve runtime permissions. Launch has no retry key; send has clientRequestId. Launch explicitly binds an existing isolated worktree; preparation is checked before accepting that binding.

No private T3 RPC approximation is provided. Changed/unsupported contracts fail explicitly. Live provider execution remains a separate acceptance gate.
