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
# Portable bridge checkpoint: 2026-10-20

The portable `bridge-*` commands use Grok Bot or another MCP client as the reasoning supervisor and require no xAI API key. This checkpoint is separate from the legacy autonomous supervisor evidence below.

- `npm run check`: strict production/test TypeScript checks, **76 tests across 9 files**, and build passed.
- Compiled stdio child-process smoke: 11 bridge tools exposed, including start/attach; discovery succeeded.
- Real local Streamable HTTP and legacy SSE integration: discovery, exact-model rejection, idempotent start, permission response, completed-turn review, verifier environment secret redaction, and verification-gated finish passed.
- Independent QA reproduced and confirmed fixes for terminal-state races, dangling Windows junction scope escape, outside-worktree native file approvals, cancellation, restart continuation, import aliases, secret redaction, wrapper request timeouts and T3 question-arrival races. A real 31-second HTTP verification call passed after the timeout fix.
- Live Codex `gpt-6.1-sol`: exact model selection and native resume succeeded. Full bridge MCP workflow created `proof.txt` containing `BRIDGE_LIVE_OK` in an isolated disposable worktree, approved the exact scoped edit, ran an independent file-content verifier, handled `BRIDGE_FOLLOWUP_OK`, and finished with the source checkout unchanged.
- Live OpenCode ACP `openai/gpt-6.1-sol`: selected the model and returned `OPENCODE_BRIDGE_READY`.
- Live T3 authenticated MCP: launched Codex `gpt-6.1-sol` in an explicit isolated worktree; received `T3_BRIDGE_READY`; enrolled/imported that same native thread, continued it and received `T3_BRIDGE_IMPORTED`; verified and finished. The probe used a short-lived token scoped to orchestration read/operate. This proves session control, not implementation of a coding feature. Native thread: `mcp:eca27ac4-3197-43af-9805-021938808c0a`.
- Native Claude transport returned `Not logged in`; live Claude task execution remains blocked by authentication.
- Grok Bot desktop handoff and Antigravity worker control remain **unverified/unavailable**, respectively. No claim of universal application certification, a Grok Bot-driven run, OS sandboxing or TestSprite acceptance is made. See [bridge setup and limits](BRIDGE.md).

