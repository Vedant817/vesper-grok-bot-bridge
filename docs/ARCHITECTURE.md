# Architecture Specification: Universal Grok Agent Supervisor

## 1. System Components

```
┌─────────────────────────────────────────────────────────────┐
│                 Grok Cognitive Engine                       │
│    (xAI Grok-4 / Grok-Build / Grok-3 High Reasoning)        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                 Supervisor Core Engine                      │
│  - Task DAG & Goal State Machine                            │
│  - Interactive Decision Classifier (Question vs Permission)  │
│  - Turn Evaluation & Diff Verification                      │
│  - Context Compressor & Memory Compaction                   │
│  - Safety Firewall & Secret Redaction                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                Universal Adapter Layer                      │
│  ├── T3 Code Adapter (HTTP MCP / WS RPC)                    │
│  ├── Standard ACP Adapter (Agent Client Protocol)           │
│  ├── Codex Adapter (App-Server RPC)                         │
│  └── PTY Adapter (Virtual Terminal Fallback)                │
└─────────────────────────────────────────────────────────────┘
```

## 2. Invariants & Guarantees
1. **Never mutate uncommitted human workspace**: Always require worktrees or isolated task checkouts.
2. **Context Window Ceiling**: Keep supervisor prompt under 8k tokens using summary rollups.
3. **Loop Bounds**: Max 5 iterations per sub-milestone before escalation.
4. **Destructive Command Interception**: Blacklist dangerous patterns (`rm -rf`, `DROP TABLE`, `git push --force`).
