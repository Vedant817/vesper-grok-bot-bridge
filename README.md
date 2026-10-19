# Grok-Bot-MCP-Agent

Universal AI-in-the-Loop Grok Supervisor and Autonomous Human Proxy for T3 Code, ACP Agents (Claude Code, Devin, Kiro, OpenCode), and OpenAI Codex.

## Overview
`grok-bot-mcp-agent` acts as an autonomous human operator for AI coding tools. Instead of requiring a human developer to monitor turns, answer interactive questions, approve destructive shell commands, and formulate follow-up prompts, Grok takes over the supervisory loop:

1. **Autonomous Thread & Worktree Management**: Launches isolated task branches and monitors status.
2. **Interactive Question & Approval Handling**: Intercepts `ask_question`, permission checks, and plan reviews.
3. **Turn Verification & Feedback**: Inspects diffs, runs test suites, checks acceptance criteria, and issues steering or follow-up prompts.
4. **Context Bloat Mitigation**: Uses hierarchical memory compaction and sliding windows to prevent context saturation.
5. **Safety Firewalls**: Guardrails against destructive shell commands, secret leaks, and infinite recursion traps.

## Multi-Protocol Architecture
- **MCP (Model Context Protocol)**: Connects to T3 Code's HTTP/SSE MCP endpoints (supporting both MCP 2025-06-18 and legacy 2024-11-05).
- **ACP (Agent Client Protocol)**: Interoperable with standard ACP JSON-RPC agents (Claude Code, Devin, Kiro, OpenCode 2).
- **Codex RPC / Terminal PTY**: Bridges CLI-only agents into structured event streams.

## Development Setup
```bash
pnpm install
pnpm dev
pnpm test
```
