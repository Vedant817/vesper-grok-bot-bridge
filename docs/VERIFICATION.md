# Verification and remaining acceptance gates

Local evidence: Windows, Node 24.13.1, npm 11.8.0, 2026-10-19. The initial repository was a scaffold with no tests. Implementation used a linked development worktree, feature-scoped commits and independent senior QA checkpoints.

## Executed local checks

- npm run check: production/test strict TypeScript checks, 50 Vitest tests across five files and compiled build.
- npm audit --audit-level=moderate: zero reported vulnerabilities after updating vulnerable scaffold test dependencies.
- npm pack --dry-run: compiled entrypoint/declarations, examples, docs and license; no credential files or test state.
- Compiled CLI help and a real stdio MCP client smoke test passed; permission_evaluate returned blocked for a destructive command.
- Real loopback MCP requests negotiate 2025-06-18 and 2024-11-05. Tools work over Streamable HTTP and authenticated legacy SSE; cancellation reaches the active task signal.
- Negative tests reject wrong credentials, hostile Origin/Host, malformed JSON and invalid arguments. Malformed initialize requests release their session slots.
- A real ACP fixture process initializes, creates a session, requests permission, receives denial, streams output and completes. Application integration creates a real worktree, runs a real verifier process and preserves dirty source files.
- Native node-pty runs on Windows and stops at an approval-shaped terminal prompt.
- Safety/memory tests cover exact argv decisions, split bearer tokens, multiline PEM, overflow suppression, configured secrets including JSON escaping, byte bounds and cold lookup validation.
- Loop/cleanup tests cover failed verification despite model approval, unchanged repairs, hung waits/close, whitespace filenames, more than 200 untracked files and framed content fingerprints.
- Adapter/AST/DAG tests cover malformed ACP results, stale Codex turns, correlation/disconnects, bounded queues, exact response shapes, changed object methods and dependency failures.

## QA repairs

Independent reviewers reproduced redaction bypasses, cleanup hangs, flattened argv checks, incomplete or ambiguous content fingerprints, AST symbol collisions, malformed ACP crashes, stale Codex completion, cancellation loss, provider error leakage and malformed-session exhaustion. Repairs have regression coverage.

## Remaining boundaries

- Live Grok: XAI_API_KEY was absent. Responses behavior is fixture-tested; no live inference or model-quality claim. Supply a local key and run one bounded real milestone to complete this gate.
- Real providers: Claude Code, Devin, Kiro, OpenCode and Codex coding runs were not certified. ACP subprocess proof uses a fixture. T3 contracts/discovery were inspected; no new top-level worker thread was launched for testing.
- T3 runtime approvals: unavailable through pending-question MCP; these fail explicitly.
- ACP elicitation and PTY approvals: autonomous acceptance is refused; use an appropriate structured contract or genuine human consent flow.
- Hosted CI/Linux: workflow is included; no hosted run or Linux result has been observed.
- TestSprite: CLI/auth preflight succeeded, but no matching project exists. This local CLI/MCP package has neither a browser UI nor a public backend target for the available runner. No TestSprite PASS is claimed; unrelated projects were untouched.
- OS containment: worktree boundaries/requested provider sandboxes do not prove native process-tree, filesystem, home-directory credential or network isolation.
- Recovery/retention: persisted inspection records are not automatic replay. Cross-process leases, crash recovery, tamper-resistant audit storage, quotas and scheduled cleanup remain outside this implementation.

Local PASS does not certify a production replacement for every human approval surface.
