# Verification and remaining acceptance gates

## General ACP and live provider checkpoint: 2026-10-22

- [The connection guide](CLI_CONNECTIONS.md) distinguishes T3's native MCP routing from standalone ACP workers. Official current sources establish maintained Codex/Claude ACP adapters and native Grok Build/OpenCode plus Google's standalone Antigravity server. Historical blanket Antigravity-unavailable statements below are superseded; standalone enrollment remains separate from T3-managed access.
- Grok Bot initiated five isolated T3 threads through its native connector. Independent transcript reads confirmed two exact sentinel replies in the same Codex and Antigravity threads. Claude returned native login-required, Grok Build HTTP 402 balance-exhausted, and OpenCode HTTP 401. All five test worktrees were unchanged. No authentication/quota failure was retried or concealed by account, model, budget, or permission changes.
- Installed maintained adapters in a separate per-user directory: Codex ACP 2.2.2 and Claude ACP 0.94.0. Both passed actual ACP v1 initialization; only Codex passed two actual generic-worker turns. Grok Build 1.0.62 passed initialize/native cached authentication/session creation; inference was blocked as detailed in the guide. No private T3 provider credentials were copied.
- The installed bridge was upgraded with no managed sessions. One-time `provider add` saved both ACP launchers while stopped, then the daemon restarted and discovered the saved configurations with `authentication:"not_checked"`. Through the installed authenticated MCP server, Codex ACP passed two sentinel turns and preserved its worktree. A validation error in the probe's initial wait arguments was corrected by reconciling the original session, without another launch. The probe was cancelled cleanly; this did not bypass the normal verification/finish gate.
- Independent QA passed 60 focused protocol/authentication/process tests and 29 enrollment/bridge tests; real disposable-home enrollment preserved literal arguments, issued initialization only, and skipped the probe for identical input. Stdio process tests verify owned Windows descendant teardown and pipe cleanup, not a universal native-cancellation acknowledgment or POSIX certification.
- Final local gate: strict production/test TypeScript and build passed; `npx vitest run --cache=false --maxWorkers=1` passed **270 tests across 24 files** after the discovery redaction regression was added.
- A separate owner-approved Grok Bot bootstrap action created/amended an “Initial commit” checkpoint and renamed the active branch to main while implementation was in progress. Inspection confirmed prior history remained as its parent and concurrent edits were preserved; this session did not reset or rewrite that history. Bot instructions now explicitly distinguish null project repository metadata from an absent Git repository.
- TestSprite CLI 0.14.0/authentication were available, but its project inventory has no target for this stdio CLI/MCP package. No hosted frontend/public backend exposing this implementation exists, so no meaningful TestSprite run was dispatched. Local fixture/native evidence is not hosted TestSprite acceptance. Provider account failures, independent Claude/Grok/OpenCode task access, standalone Antigravity enrollment, physical reboot, and mobile-triggered operation remain qualified separately.

## Distribution checkpoint: 2026-10-22

- `npm run lint` passed both TypeScript checks. `npm pack --pack-destination build/releases --json` built the optional CLI package successfully; its 215 entries matched the package allowlist and included the native T3 guides and runtime lock. No runtime behavior changed, so the historical runtime test counts below were not rerun for this documentation/build change. The applicable TestSprite instructions exempt docs/build-config changes.
- `npm run pack:onboarding` produced a documentation-only archive and SHA-256 sidecar. Fresh extraction found exactly five expected files, all five relative Markdown links resolved, the manifest had no scripts/dependencies and was private, and checks found no owner endpoint or home path. Independent QA reproduced these results in a separate disposable directory and found no concrete blockers.
- Both downloads are local build artifacts, not an npm release or marketplace plugin. No public upload or registry publication occurred. The onboarding kit needs no installation; the optional CLI package has its own runtime and setup requirements.

## Native Grok Bot connector checkpoint: 2026-10-22

- The owner's public T3 endpoint returned HTTP 200 protected-resource metadata with a matching `/mcp` resource and authorization server. The endpoint is deliberately omitted from distributed documentation.
- Through the installed Grok Bot UI, the Coding Agent Supervisor created a native `t3-connect` Remote HTTPS connector and presented an OAuth authorization card. The owner then reported that it worked. This is owner-reported authorization/connection success, not an independently captured new-thread/continuation or coding acceptance run.
- The [native quickstart](T3_CONNECT_QUICKSTART.md) now takes precedence over historical statements below that only local-terminal handoff was established. It includes explicit read-only discovery and isolated new-thread/continuation acceptance prompts. The optional bridge's OAuth enrollment remains a separate flow.
- Grok Bot's cloud connector does not require its desktop window to stay open. The coding host, T3 backend, Connect tunnel, and selected native providers must remain available. Windows background T3 service support, reboot persistence, mobile-triggered coding, and behavior across host sleep remain separate acceptance limits.

## Local desktop discovery checkpoint: 2026-10-22

- The owner selected supervision on this computer first. Mesh remains optional and uninstalled; no remote execution, SSH enrollment, or shared OpenCode configuration changes were made.
- `npm run lint`, serial Vitest, and build passed: **241 tests across 20 files**. Independent QA closed the Windows casing and ambiguous-launch findings, with **7 launcher tests and 20 adversarial checks passed**.
- The standard managed installation was upgraded while no coding sessions were active. Existing client registrations and scheduled startup were preserved. The installed module automatically discovered T3 Desktop from its public launcher data and successfully ran the supported `connect status --json` command through the discovered native prefix. No manual executable path or copied native credential was needed.
- Final `doctor`: healthy daemon, credential OK, launcher present, PTY available, scheduled-task startup, and no startup error. Host setup reported authenticated and linked; this does **not** establish live bot OAuth approval, Grok Bot UI handoff, or reboot acceptance. Those gates remain open.

## Supervision and Connect checkpoint: 2026-10-22

- Final gate: `npm run lint`, `npm exec -- vitest run --cache=false --maxWorkers=1`, and `npm run build` passed: **234 tests across 19 files**. The default parallel headless run encountered a native Windows ConPTY worker crash; the serial full suite and a separate console-backed PTY run passed. Parallel headless native-PTY stability remains a limitation.
- Independent reviewers reproduced crash-recovery scope collisions, alternate request/task identity bypasses, direct resume bypass, human-question escalation bypass, post-verification shutdown writes, unknown native ownership release, pre-send rejection poisoning, stale request races, and startup/cancellation races. All identified paths were repaired. The final reviewer-authored disposable fixtures were rerun after the last fixes: **6/6 passed**. This is distinct from a fresh reviewer approval of the final commit.
- Retained crash regressions terminate actual child processes immediately after fixture native start/continuation submission. Fresh request IDs, alias task keys, direct resume and follow-up cannot replay the retained uncertain session. Unknown shutdown retains durable native/worktree ownership and cannot become ordinary cancelled monitoring.
- Connect tests use real MCP SDK initialization/OAuth processing against disposable mapped servers, actual stdio child processes, and a temporary real CurrentUser Windows DPAPI store. They cover endpoint binding, PKCE/state/issuer, malformed callbacks, expiry/401, child environment versus argv, redaction, custom-home enrollment preservation and configuration rollback. They do not prove public T3 Connect authorization.
- The installed T3 CLI's supported `connect status --json` reported desired/authenticated/linked true, revoked false, and relay client available. This is saved host setup, not live reachability or bot enrollment. `t3-connect status` on the bridge reports that no bot endpoint is enrolled. No T3 private signing or credential files were copied.
- The feature was fast-forwarded into the primary checkout and installed at the standard per-user home using `setup --repository <primary-checkout> --no-clients --no-autostart`. Existing client registrations and scheduled startup were preserved. The retained previous release exists, and the updated installed job description includes dispatch/wait/monitor and human-only boundaries.
- Actual installed stdio acceptance exposed **14 tools**, including `agent_dispatch`, `agent_monitor`, and `agent_wait`. With no active sessions, the daemon was stopped and restarted through its authenticated control API; the **same client** called `agent_monitor` successfully afterward. The credential file's size/modification time was unchanged across restart. Client close left the daemon healthy. Final `doctor`: healthy, credential OK, launcher present, scheduled-task autostart, no startup error.
- Grok Bot desktop handoff, live public MCP OAuth approval, a physical reboot/sign-in cycle, and installed Claude control-protocol compatibility remain unverified. The caller must remain active to supervise; there is no hidden Grok reasoning process. Antigravity has no built-in supported worker control API. No account-policy immunity or universal human-approval replacement is claimed.
- [Hona/mesh was researched](research/MESH.md) as an optional remote transport companion; it was not installed or enrolled. TestSprite has no matching browser/public-backend target for this CLI/MCP package; no hosted certification is claimed.

## Managed installation checkpoint: 2026-10-22

- `npm run check`: strict production/test TypeScript checks, **114 tests across 11 files**, and build passed.
- Independent senior QA reproduced missing-receipt owner bypass and rollback-release deletion, then confirmed both fixes. The final startup-race regression passed independently. Real Windows Script Host testing verifies that daemon exit code 23 reaches the trampoline caller; Windows ACL checks verify owner/SYSTEM access.
- Actual default installation at `%LOCALAPPDATA%/GrokAgentBridge` succeeded. Codex, Claude Code and OpenCode have persisted local MCP registrations; existing matching entries were preserved on repeat setup. Provider authentication and hosted model execution remain separate checks.
- A repeat upgrade retained its previous release on disk. The installed artifact and production dependencies are outside the source checkout. The user PATH entry is persisted.
- The actual scheduled task was invoked after stopping the installed daemon. A new authenticated daemon instance became healthy; its DPAPI credential was unchanged and `agent_discover` succeeded without manual endpoint or token configuration. This verifies task activation, **not a physical reboot or sign-out/sign-in cycle**.
- An actual installed stdio client discovered all 11 tools, successfully called `agent_sessions`, survived a daemon stop/start, and called it again through the same proxy connection. Closing the client left the daemon healthy.
- Grok Bot's own local-execution policy and UI handoff remain unverified. Antigravity still has no built-in control adapter. No universal-provider, OS-sandbox, Linux/macOS autostart or TestSprite certification is claimed.

## Portable bridge checkpoint: 2026-10-20

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

## Historical autonomous checkpoint: 2026-10-19

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
