# Architecture

Owner configuration selects the source repository, external state directory, worker adapter, Grok model, verifier and finite limits. application.ts serializes runs, creates detached linked worktrees from committed HEAD, performs optional setup and constructs the supervisor. Worker/model output cannot change configuration.

Supervisor.run enforces linked-worktree identity before starting a worker. Output is buffered into redacted records and cold storage. Permission events go to deterministic policy. Technical questions go to Grok with a goal, bounded context and optional exact choices; approval-shaped questions stop. A completed turn invokes the verifier, captures git/AST summaries and asks Grok to evaluate evidence. Acceptance requires both verifier and model approval. Failure steers the worker until a repetition guard, event/turn cap or deadline stops it. Cancel and close have bounded cleanup waits.

Worker and Reasoner are narrow interfaces. RpcWorker shares bounded queues, request correlation, unknown-method rejection and closing behavior across ACP/Codex. McpConnection uses the official SDK for HTTP/SSE framing and negotiation. T3 uses observed MCP contracts rather than invented private RPC methods.

Memory stores redacted JSON by SHA-256 and evicts working records by UTF-8 bytes. Disk cold storage satisfies persistence without SQLite. Changes hashes full tracked diffs as streams and all regular untracked files with framed per-file digests. AST summaries include names, not bodies. TypeScript is pinned to its stable compiler API.

runTaskGraph validates dependencies before side effects, executes sequentially and skips dependents after noncompletion. Separate worktrees are retained; code is not implicitly merged. Dependency paths are read-only context.

HTTP sessions preserve request cancellation controllers. Every HTTP request authenticates and passes host/origin checks. Fixed error payloads avoid leaking provider-generated fragments. Stdio emits protocol frames only on stdout.

## Trust boundaries

- Worktrees isolate tracked edits, not OS authority. Workers may still reach home-directory credentials, network or sibling directories unless external controls prevent it.
- The owner verifier and its test files must be trustworthy. Exit status is not proof that assertions are sufficient or immune to worker edits.
- Workers may execute operations without requesting permission. The firewall covers only intercepted requests.
- Tool/repository output is untrusted model input. Grok has no shell/network tools in this package, and its decisions cannot grant permissions.
- Pattern filtering cannot prove universal command safety or identify every secret. Unknown actions are refused.

Production rollout still requires scoped credentials, OS isolation, real-provider acceptance, hosted CI evidence, retention rules and any desired cross-process/crash-recovery controls. Fixture success is not production proof.
