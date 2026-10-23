# System design: Grok Bot coding-agent bridge

Repository-grounded diagram pack for community posts and interviews. Inspected 23 October 2026 at base commit `3d121f7`, including the current working tree. Existing local changes in `src/index.ts`, `src/rpc.ts` and `src/bridge/service.ts` were left untouched.

## The 30-second explanation

Grok Bot supervises coding work through MCP. Users choose either T3's existing Connect server or this project's standalone bridge. The standalone bridge maps validated tools to exact native coding sessions, keeps task identities and recovery receipts on disk, runs workers in detached Git worktrees, and only accepts reviewed work when owner-configured verification still matches the current files. It is a single-owner local orchestration system with optional authenticated remote ingress.

## 1. Community overview

Use this diagram in a community post. Nodes identify product ownership; edge labels identify the protocol between layers. These are alternative routes selected explicitly, not automatic fallback paths.

```mermaid
flowchart TB
  Owner["Owner / developer"]
  Bot["Grok Bot / Vesper templates<br/>Supervision, technical answers, review"]
  Owner -->|"Task and acceptance criteria"| Bot
  subgraph T3Route["Route A - T3 product boundary"]
    Relay["T3 Connect<br/>HTTPS /mcp + T3 OAuth"]
    T3["T3 Code MCP server<br/>t3_* tools, projects and threads"]
    T3Workers["T3-configured coding providers<br/>Native sessions and workspaces"]
    Relay <-->|"T3-managed relay connection"| T3
    T3 <-->|"T3-owned orchestration"| T3Workers
  end
  subgraph CLIRoute["Route B - owner coding computer"]
    Gateway["Owner HTTPS ingress<br/>Reverse proxy / tunnel / optional Funnel"]
    Bridge["Standalone MCP bridge<br/>Node.js 22+, TypeScript, Express 5<br/>MCP SDK + Zod"]
    Router["TaskRouter + BridgeService<br/>Exact provider/model, session IDs<br/>Durable receipts and bounded monitoring"]
    Native["Native workers<br/>Codex app-server / Claude stream-json<br/>ACP v1: OpenCode, Grok Build, enrolled adapters"]
    Work["Detached Git worktrees<br/>Owner verifier + SHA-256 change evidence"]
    State[("Owner-local files<br/>JSON snapshots, routing receipts<br/>Protected credentials and runtime records")]
    Gateway <-->|"HTTP to 127.0.0.1<br/>Bridge OAuth bearer on /mcp"| Bridge
    Bridge <-->|"Validated agent_* calls"| Router
    Router <-->|"Child-process stdio protocols"| Native
    Native <-->|"Repository edits and project checks"| Work
    Router <-->|"Persist / recover"| State
    Router -->|"Verify then finish"| Work
  end
  Bot <-->|"MCP over HTTPS<br/>T3 OAuth credential"| Relay
  Bot <-->|"MCP over HTTPS<br/>Separate bridge OAuth credential"| Gateway
  Native <-->|"Provider-managed network / authentication"| APIs["Selected provider services<br/>Native CLI owns account authentication"]
  classDef core fill:#dbeafe,stroke:#2563eb,color:#10254a
  classDef external fill:#f1f5f9,stroke:#64748b,color:#172033
  class Bridge,Router core
  class Owner,Bot,APIs,Relay,T3,T3Workers external
```

## 2. Standalone layers and networking

The local daemon and remote listener are distinct. The remote endpoint proxies into the same managed backend. Port 43189 is a documented example, not a required default; the managed local MCP port is dynamic.

```mermaid
flowchart TB
  Cloud["Grok Bot cloud MCP client"]
  Local["Local MCP host<br/>Codex / Claude / OpenCode client"]
  Admin["Owner CLI<br/>setup / doctor / start / stop / remote approve"]
  subgraph Edge["Owner-controlled network edge"]
    TLS["HTTPS ingress - typically TCP 443<br/>Reverse proxy / tunnel / optional Tailscale Funnel<br/>TLS termination"]
  end
  subgraph Host["Single-owner coding host"]
    Remote["Remote listener - Express + MCP SDK<br/>127.0.0.1:configured port, e.g. 43189<br/>Streamable HTTP /mcp"]
    Auth["OAuth authorization code + PKCE S256<br/>Local owner approval, coding:operate scope<br/>Host / Origin / resource / expiry checks"]
    Proxy["Managed MCP proxy<br/>agent_* tools only"]
    Stdio["connect command<br/>MCP SDK stdio transport"]
    Daemon["Managed daemon - local MCP server<br/>127.0.0.1:dynamic port<br/>Bearer-auth /mcp; legacy /sse + /messages"]
    Control["Local control IPC<br/>Windows named pipe / Unix socket<br/>HMAC-SHA256 authenticated requests and responses"]
    Tools["MCP tool registration + Zod schemas"]
    Service["TaskRouter + BridgeService<br/>Serialized mutations, request correlation<br/>Session lifecycle, monitoring, redaction"]
    Adapters["Worker interface / provider discovery<br/>Codex | Claude | ACP"]
    Processes["Native CLI child processes<br/>shell:false, hidden Windows processes"]
    Files[("Owner-managed filesystem<br/>Config, DPAPI credential blob on Windows<br/>Sessions, routing.json, worktrees")]
    Remote --> Auth --> Proxy
    Stdio --> Proxy
    Proxy <-->|"Loopback HTTP + local bearer"| Daemon
    Daemon --> Tools --> Service --> Adapters
    Adapters <-->|"stdin/stdout framed JSON"| Processes
    Service <-->|"Filesystem APIs + Git subprocesses"| Files
    Control <-->|"Health / stop"| Daemon
    Admin <-->|"Local authenticated IPC"| Control
    Admin -->|"Signed local owner requests"| Auth
    Admin -->|"Enrollment / installation"| Files
  end
  Cloud <-->|"HTTPS + OAuth bearer<br/>MCP JSON-RPC"| TLS
  TLS <-->|"HTTP over loopback<br/>Public Host preserved or supported loopback rewrite"| Remote
  Local <-->|"stdin/stdout JSON-RPC"| Stdio
  Processes <-->|"Provider-owned outbound connectivity"| Provider["Provider backend<br/>Credentials stay in native CLI"]
  Private["Optional Tailscale Serve<br/>Tailnet devices only + bridge OAuth"] -.-> TLS
```

Network boundaries:

- Cloud client to owner ingress: HTTPS carrying MCP JSON-RPC. TLS terminates at the owner-controlled ingress.
- Ingress to remote listener: HTTP to `127.0.0.1:<configured port>`. The bridge itself does not terminate public TLS.
- Remote / local stdio proxy to daemon: authenticated loopback MCP HTTP, using the locally protected bridge bearer.
- Owner control to daemon: named pipe on Windows or Unix socket elsewhere, authenticated with HMAC-SHA256. This is not the public MCP endpoint.
- Bridge to native CLI: local process pipes with the selected protocol. Provider network calls and login are owned by the native CLI.
- Public OAuth discovery/enrollment endpoints are reachable before MCP authorization; owner approval endpoints require signed local requests.
- Legacy local HTTP supports `/sse` plus message POSTs; the standalone remote listener uses Streamable HTTP at `/mcp`.
- Tailscale Funnel is optional public ingress. Serve is optional private tailnet ingress. Neither authenticates the coding-provider account.

## 3. Standalone authorization sequence

This describes this repository's remote OAuth implementation, not T3's internal OAuth implementation. Requests traverse the same ingress even where sequence arrows omit that hop for readability.

```mermaid
sequenceDiagram
  actor Owner
  participant Bot as Grok Bot MCP client
  participant Edge as Owner HTTPS ingress
  participant Auth as Bridge OAuth server
  participant CLI as Local owner CLI
  participant Store as Owner-local OAuth state
  Bot->>Edge: Discover protected /mcp resource and OAuth metadata
  Edge->>Auth: Forward to loopback listener
  Auth-->>Bot: Authorization, registration and token endpoints
  Bot->>Auth: Register callback and initiate authorization with PKCE S256
  Auth-->>Owner: Pending connector, callback and local approval requirement
  Owner->>CLI: Inspect pending request, approve exact request ID
  CLI->>Auth: Loopback-only signed owner approval
  Auth->>Store: Persist approved client
  Auth-->>Bot: Redirect to registered callback with authorization code
  Bot->>Auth: Exchange code + PKCE verifier
  Auth-->>Bot: Scoped access token, no refresh-token grant
  Bot->>Edge: POST /mcp with Bearer credential
  Edge->>Auth: Forward HTTP to 127.0.0.1
  Auth->>Auth: Validate Host, Origin if supplied, token, scope and resource
  alt Authorized
    Auth-->>Bot: MCP initialization / tool response
  else Expired, revoked or invalid
    Auth-->>Bot: 401, explicit reauthorization required
  end
  Note over Owner,Store: Bridge access does not authenticate Codex, Claude, ACP providers or T3
```

## 4. Task lifecycle, persistence and acceptance

This is the `agent_dispatch` path. Direct `agent_start` is also available. Reuse a stable request ID only for the same input; retain exact bridge and native session IDs.

```mermaid
sequenceDiagram
  actor Owner
  participant Bot as Grok Bot supervisor
  participant MCP as MCP tools
  participant Router as TaskRouter
  participant State as Durable JSON state
  participant Bridge as BridgeService
  participant Worker as Native worker
  participant Git as Git worktree
  participant Verify as Owner verifier
  Owner->>Bot: Task, exact provider/model and repository
  Bot->>MCP: agent_discover
  MCP-->>Bot: Availability, models, protocols and limitations
  Bot->>MCP: agent_dispatch(taskKey, requestId, instruction)
  MCP->>Router: Validate exact task identity
  Router->>State: Persist prepared receipt before mutation
  alt New task
    Router->>Bridge: Start with stable request identity
    Bridge->>Git: Detached linked worktree from committed HEAD
    Bridge->>State: Persist session snapshot before native execution
    Bridge->>Worker: Initialize and submit task in worktree
  else Existing completed or interrupted task
    Router->>Bridge: Continue exact retained session
    Bridge->>Worker: Follow-up / native resume where supported
  else Active or terminal task
    Router-->>Bot: Observe, instructionSubmitted = false
  end
  Router->>State: Persist known outcome and session binding
  loop Bounded supervision
    Bot->>MCP: agent_wait / agent_read / agent_monitor
    MCP-->>Bot: Redacted activity, cursor, pending input and status
    Worker-->>Bridge: Technical question or permission event
    Bridge->>Bridge: Deterministic policy and human-only classification
    opt Input can be delegated
      Bot->>MCP: agent_respond(sessionId, requestId)
      MCP->>Worker: Valid answer or permitted scoped response
    end
    opt Credentials or human-only approval
      Bot-->>Owner: Native human handoff
    end
  end
  Worker-->>Bridge: Turn completed, awaiting_review
  Bot->>MCP: agent_verify
  MCP->>Verify: Run owner-configured executable and arguments
  Verify-->>Bridge: Exit status and redacted output
  Bridge->>Git: Capture HEAD and change fingerprint
  Bridge->>State: Persist evidenceId and contentHash
  MCP-->>Bot: Verification and change evidence
  alt Review finds gaps or verification fails
    Bot->>MCP: agent_followup with concrete corrections
    MCP->>Worker: Continue same native session
  else Reviewed and passing
    Bot->>MCP: agent_finish(sessionId, evidenceId)
    MCP->>Bridge: Check latest passing evidence and current fingerprint
    Bridge->>Worker: Bounded shutdown
    Bridge->>Git: Recheck fingerprint after shutdown
    Bridge->>State: Mark finished only if evidence still matches
    MCP-->>Bot: Accepted, retain worktree and evidence
  end
  Note over Router,Worker: An uncertain native submission is inspected, never blindly replayed
  Note over Bridge,Git: Finish does not commit, merge, push or delete the worktree
```

The loop represents repeated MCP observations, not a background cloud queue. `agent_wait` waits at most 30 seconds per call. The core bridge does not contain its own reasoning model: Grok Bot reviews evidence and requests follow-ups. A crash can leave an uncertain submission; durable intent makes that uncertainty visible, but does not make native execution exactly once.

Worktrees begin at committed HEAD; uncommitted source changes, ignored files and dependencies are not copied. Owner configuration fixes the verifier executable/arguments; project test code still needs to be trustworthy.

## 5. Optional integrations and legacy supervisor

The optional bridge-to-T3 provider is implemented, but the recommended T3 community route connects Grok Bot directly to T3. The bottom subgraph is a separate API-key execution mode.

```mermaid
flowchart TB
  subgraph Advanced["Optional bridge-to-T3 integration"]
    Bridge["Bridge provider discovery"]
    Catalog["T3 orchestrator_capabilities<br/>Exact provider instance and model"]
    Connect["src/connect<br/>OAuth PKCE enrollment + credential reference"]
    Official["Preferred official T3<br/>acp-mcp-bridge over local stdio"]
    SDK["Fallback MCP SDK HTTPS transport"]
    T3["T3 MCP endpoint<br/>Local configured endpoint or remote T3 Connect"]
    Thread["T3Worker<br/>Thread launch / wait / read / send / interrupt<br/>Pending questions; native permission boundary"]
    Bridge --> Catalog
    Bridge --> Connect
    Connect -->|"Launcher available"| Official
    Connect -->|"Launcher absent"| SDK
    Official -->|"HTTPS /mcp"| T3
    SDK -->|"HTTPS /mcp"| T3
    Catalog <--> T3
    T3 <--> Thread
  end
  subgraph Legacy["Legacy API-key supervisor - optional separate mode"]
    Entry["run / run-plan / serve-stdio / serve-http"]
    App["application + Supervisor<br/>One active run; finite turns, events and deadline"]
    Policy["Deterministic permission policy<br/>Unknown or human-only operations stop"]
    Reasoner["GrokReasoner<br/>Zod-validated answers and evaluation"]
    XAI["xAI Responses API<br/>HTTPS POST /v1/responses<br/>Explicit model + XAI_API_KEY; store:false"]
    Workers["Worker adapters<br/>ACP stdio / Codex stdio or WebSocket<br/>T3 MCP / optional node-pty terminal"]
    Memory[("Bounded redacted working memory<br/>SHA-256 addressed JSON cold storage")]
    Evidence["Owner verifier + Git change hashes<br/>TypeScript AST symbol summaries"]
    Entry --> App
    App --> Policy
    App <--> Reasoner
    Reasoner <-->|"Node fetch + API bearer"| XAI
    App <--> Workers
    App <--> Memory
    App --> Evidence
    Evidence -->|"Verifier passes AND reasoner accepts"| Done["Complete and retain worktree"]
  end
```

Connect credentials are endpoint-bound. Expiry or a rejected credential requires explicit enrollment again. The official stdio bridge and direct SDK HTTPS transport are distinct implementations; do not assume every transport has identical internal redirect behavior.

Legacy `run-plan` validates task dependencies and runs them sequentially, skipping dependents after noncompletion. It retains separate worktrees and does not implicitly merge them. GrokReasoner supplies technical answers and acceptance evaluation; deterministic permission policy retains authority.

## Shareable files

Open the [offline interactive explorer](diagrams/explorer.html) for tabs, zoom, Mermaid source and SVG downloads. It embeds pre-rendered SVGs and requires no CDN or server. Mermaid sources are the editable originals; regenerate SVGs and the explorer after changing them.

| View | Mermaid source | SVG image |
| --- | --- | --- |
| Community overview | [01-system-overview.mmd](diagrams/01-system-overview.mmd) | [SVG](diagrams/01-system-overview.svg) |
| Layers & networking | [02-standalone-layers-network.mmd](diagrams/02-standalone-layers-network.mmd) | [SVG](diagrams/02-standalone-layers-network.svg) |
| OAuth enrollment | [03-oauth-enrollment.mmd](diagrams/03-oauth-enrollment.mmd) | [SVG](diagrams/03-oauth-enrollment.svg) |
| Task & acceptance | [04-task-verification-sequence.mmd](diagrams/04-task-verification-sequence.mmd) | [SVG](diagrams/04-task-verification-sequence.svg) |
| Optional & legacy | [05-optional-and-legacy.mmd](diagrams/05-optional-and-legacy.mmd) | [SVG](diagrams/05-optional-and-legacy.svg) |

## Technology inventory

| Layer | Technology actually used | Role / boundary |
| --- | --- | --- |
| Supervisor / community | Grok Bot; Vesper CLI and T3 instruction profiles | External reasoning client; templates are publisher source, not published marketplace links. |
| Runtime / language | Node.js >=22; TypeScript 5.9.3; ESM | CLI entrypoints and background daemon. CI uses Node 24. |
| MCP | @modelcontextprotocol/sdk ^1.32.1 | JSON-RPC tool contracts; stdio, Streamable HTTP and legacy SSE transports. |
| HTTP / validation | Express ^5.3.0; Zod ^3.25.76 | Routing, strict schemas, OAuth and request validation. |
| Core orchestration | TaskRouter, BridgeService, Worker interface | Durable dispatch receipts, sessions, bounded monitoring and exact provider/model selection. |
| Native protocols | ACP v1; Codex app-server; Claude bidirectional stream-json | Local child-process stdin/stdout; not one MCP server per provider. |
| Advanced transports | ws ^8.22.0; optional node-pty ^1.1.0 | Configured Codex WebSocket / legacy terminal adapter; not the default managed CLI route. |
| Network ingress | Owner reverse proxy / tunnel; optional Tailscale Funnel or Serve | TLS termination outside Node; loopback forwarding. Serve is private tailnet access, not generally cloud accessible. |
| Remote authorization | MCP SDK OAuth server; PKCE S256; Node crypto | Authorization-code flow, coding:operate scope, local signed approval and revocation; no refresh-token grant. |
| Local security | Bearer authentication; HMAC-SHA256 control IPC; Windows DPAPI CurrentUser | Separate local MCP, control and remote credentials. Owner-only directories; provider login stays native. |
| Persistence | Node filesystem APIs; JSON snapshots; atomic temporary-file replacement; fsync on relevant writes | Session state and routing receipts outside repositories. No SQL database, Redis or external queue. |
| Workspace / evidence | Git CLI; detached linked worktrees; SHA-256; owner verifier subprocess | Committed HEAD baseline, retained edits, current evidence gate; no automatic merge or push. |
| Legacy reasoning | Node fetch -> xAI Responses API; explicit API key/model | Only legacy supervisor uses this API directly; normal Bot supervision needs no xAI API key in the bridge. |
| Code summaries | TypeScript compiler AST | Symbol names and change summaries in legacy evidence; compiler API explains the pinned TypeScript version. |
| Local configuration | jsonc-parser ^3.3.1 | Preserves JSONC when registering supported MCP clients. |
| Installation / startup | npm release staging; PowerShell; Windows Task Scheduler / Startup fallback | Per-user managed release, launcher, rollback records and hidden sign-in startup. |
| Development / distribution | npm lockfile, tsc, tsx, Vitest, GitHub Actions, SHA-256 release sidecars | Build, type checks, fixture/integration tests, runtime archive and community publisher kit. |

Dependency versions above are declarations from package.json, not claims about the latest upstream versions.

## Interview discussion points

- **Why MCP?** A common discovery and tool interface for a supervisor, while adapters preserve each coding CLI's native lifecycle and permissions.
- **Why separate the two routes?** T3 already owns a server, accounts and threads. Installing another bridge is unnecessary for that path; its credentials and tool schemas remain separate.
- **Why persist intent before a native call?** A crash between submission and response creates ambiguity. Receipts prevent a retry from silently creating duplicate work; uncertain execution needs reconciliation.
- **Why files instead of a database?** This is a bounded, single-owner daemon. JSON records and atomic replacement keep installation simple. A multi-owner distributed service would need a different concurrency and storage design.
- **Why worktrees?** They separate repository edits and retain inspectable artifacts. They do not isolate OS permissions, home credentials or networking.
- **What proves completion?** The latest passing owner-verifier evidence and matching file fingerprint, checked again after worker shutdown. A worker's success message alone is insufficient.
- **What are the scaling limits?** One local owner/daemon, bounded sessions/events/turns and serialized mutations; no distributed worker scheduler or shared multi-tenant state.
- **What survives restart?** Retained session snapshots, IDs, receipts, worktrees and evidence. A process restart does not automatically resume a native turn; use explicit supported resume after inspection.
- **What remains human?** Account login, MFA, CAPTCHA, payment and native human-only approvals.
- **What stays external?** Grok Bot reasoning, T3's relay internals, native provider cloud architecture and the project's chosen public tunnel.

## Community post draft

> I built a TypeScript MCP bridge that lets Grok Bot supervise native coding agents. It supports explicit provider/model selection, retained native sessions, detached Git worktrees, crash-aware task routing and an evidence-based finish gate.
>
> There are two clear routes: connect directly through T3 Connect for T3 sessions, or use the standalone bridge for owner-enrolled CLIs. The standalone stack is Node.js, Express, the MCP SDK and Zod, with OAuth/PKCE for remote access and local JSON persistence.
>
> The interesting engineering problems were session identity, preventing duplicate instructions after uncertain failures, preserving native permissions, and rejecting stale verification evidence.

Attach diagram 1 to the post; use diagrams 2-5 for a technical follow-up or interview. This is a draft only; nothing has been published.

## Source map and evidence limits

| Concern | Repository sources |
| --- | --- |
| Public route ownership and templates | [README](../README.md), [route comparison](ROUTES.md), [community sources](../community/README.md) |
| MCP tools and shared HTTP transports | [server.ts](../src/server.ts), [tools.ts](../src/bridge/tools.ts) |
| Task identity, receipts, lifecycle, monitoring | [router.ts](../src/bridge/router.ts), [service.ts](../src/bridge/service.ts), [monitoring.ts](../src/bridge/monitoring.ts) |
| Provider protocol selection and native processes | [provider.ts](../src/bridge/provider.ts), [adapters](../src/adapters), [rpc.ts](../src/rpc.ts) |
| Standalone remote listener / OAuth | [http.ts](../src/remote/http.ts), [oauth.ts](../src/remote/oauth.ts), [owner-auth.ts](../src/remote/owner-auth.ts) |
| Local daemon, credential protection and IPC | [runtime.ts](../src/managed/runtime.ts), [credentials.ts](../src/managed/credentials.ts), [control.ts](../src/managed/control.ts) |
| Optional outward T3 connection | [t3-provider.ts](../src/bridge/t3-provider.ts), [connection.ts](../src/connect/connection.ts), [oauth.ts](../src/connect/oauth.ts) |
| Worktree and verification evidence | [worktree.ts](../src/worktree.ts), [verification.ts](../src/verification.ts), [service.ts](../src/bridge/service.ts) |
| Legacy supervisor and memory | [application.ts](../src/application.ts), [supervisor.ts](../src/supervisor.ts), [grok.ts](../src/grok.ts), [memory.ts](../src/memory.ts), [symbols.ts](../src/symbols.ts) |
| Stack and packaging | [package.json](../package.json), [contribution guide](../CONTRIBUTING.md), [distribution](DISTRIBUTION.md) |

These diagrams document inspected code and contracts. They do not certify hosted connectivity, provider compatibility for every release, account authorization, reboot behavior or production security. The bridge is not an OS sandbox. Community source profiles do not establish a published marketplace listing.

Raw Mermaid files are in [diagrams](diagrams); each can be pasted into a Mermaid-compatible Markdown editor.

