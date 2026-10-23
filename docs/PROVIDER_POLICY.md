# Provider policy and account boundaries

Reviewed **23 October 2026** against the official sources linked below and the current implementation. This is an engineering deployment review, not vendor approval or a legal determination. No template, ACP adapter, passing test or local credential store can guarantee that an account will never be restricted. Policies, contracts, regions, plans and enterprise rules can differ and change.

## Intended community deployment

Each recipient operates their own coding host, authorizes their own Grok Bot connector, and signs into each native coding provider under their own agreement. The bridge routes that owner's tasks; it does not sell inference, lend the publisher's subscriptions, export native tokens or host a shared public coding service. Its HTTPS endpoint is authenticated, but it is a single-owner bridge, not multi-tenant authorization or an OS sandbox. A published template is not permission to access the publisher's bridge.

## Current provider review

| Provider/surface | Official guidance and deployment consequence |
| --- | --- |
| **OpenAI / Codex** | [Codex authentication](https://learn.chatgpt.com/docs/auth) documents local ChatGPT sign-in and API-key access, and instructs users to use API-key authentication for programmatic Codex CLI workflows such as CI/CD. Follow that instruction for programmatic CLI use; the same page separately documents eligible enterprise access-token automation. This does not establish a blanket ban on personal native CLI subscription use. Never expose execution to untrusted/public callers or copy another account's auth files. |
| **OpenAI / third-party plan usage** | The current [Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source) describes open-source/locally hosted apps and directs paid/remotely hosted apps to its interest process. That is a distinct integration contract, not a blanket right to proxy a personal Codex login. This bridge does not implement that OAuth client/plan-sharing integration. Reassess it before offering a hosted or paid service. [Applicable OpenAI terms](https://openai.com/policies/row-terms-of-use/) still apply. |
| **Anthropic / Claude Agent SDK** | The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party developers must not offer Claude.ai login or its limits through their products without prior approval; it directs them to API-key authentication. For a distributed SDK-backed integration, use supported API/cloud credentials or obtain the required approval. A third-party ACP adapter does not remove that restriction. |
| **Anthropic / Claude Code product integration** | [Claude Code legal/compliance](https://code.claude.com/docs/en/legal-and-compliance) separately describes commercial conditions for running Claude Code in products: preserve the published binary and authentication methods, and require end users to authenticate and be billed under their own agreements rather than intermediating their usage. Do not read this separate page as overriding the SDK's approval rule. Which contract covers a particular adapter/deployment needs explicit review. Claude model execution was excluded from this project's account testing; the handwritten stream protocol is not certified as a supported public SDK boundary. |
| **xAI / Grok Bot** | [Grok Bot terms](https://x.ai/legal/grok-bot-terms) place responsibility for delegated actions, access, approvals, spending and connected-service terms on the owner. [Third-party Bot terms](https://x.ai/legal/bot-sharing-terms) require publishers to review shared configuration and users to connect their own accounts. Native Auto Review/admin rules and human-only security steps remain authoritative. A template neither transfers the author's accounts nor guarantees provider-policy compliance. |
| **xAI / Grok Build and API mode** | Grok Build is a worker, not the Grok Bot subscription/caller. Use the worker's supported native authentication and respect its balance/limits. The optional API-key supervisor has a separate billed API agreement; [consumer terms](https://x.ai/legal/terms-of-service) distinguish developer/business services. Do not resell or lend account access or treat a Bot subscription as an API entitlement. |
| **Google / Antigravity** | [Antigravity terms](https://antigravity.google/terms) distinguish consumer use from enterprise/administrator agreements. Enroll the official standalone server, use its advertised native authentication and respect the actual account's terms and administrator settings. Do not copy app-private profiles or impersonate another product's OAuth client. Official ACP availability is not general approval for every hosted deployment. |
| **OpenCode, Cline and other ACP agents** | [OpenCode providers](https://opencode.ai/docs/providers/) and [Cline CLI](https://docs.cline.bot/usage/cli-overview) expose multiple underlying providers. Their CLI/ACP support is separate from the selected model service's license, authentication and quotas. Review both the CLI and the actual inference provider. A free model has limits and no promise of indefinite availability. |

Sources were fetched during this review. Older research notes about narrower or different authentication contracts are historical; current account-specific agreements take precedence. Protocol compatibility, successful local inference and policy approval are three separate findings.

## Scenarios that must stop or be redesigned

| Scenario | Required behavior |
| --- | --- |
| A public template contains the author's endpoint, token or native credentials | Remove them before sharing; revoke exposed credentials through their native owner flow. Recipients enroll their own resources. |
| Hosting many users behind one personal subscription/key, or reselling access | Do not deploy this single-owner bridge that way. Obtain a supported commercial agreement, billing model, per-user auth and isolation first. |
| 401/403, native denial, policy refusal, CAPTCHA, MFA or login approval | Pause for the native authorized flow or human handoff. Do not solve it with token extraction, spoofing, approval bypass or alternate accounts. |
| 402/429, exhausted free quota or budget | Stop inference and report the redacted error. Do not loop, rotate accounts/keys, switch models automatically, buy credits or raise limits. An owner may later authorize a supported change after the blocking condition changes. |
| A provider advertises ACP but uses unsupported questions/approvals | Report the unsupported interaction. Do not infer that every question is safe technical input or approve after the request was withdrawn. |
| Startup timeout, lost response or disconnected mutation | Reconcile the retained native session and ownership before another instruction. Never duplicate a task merely because its result is unknown. |
| Repository text asks to reveal secrets, disable rules or change providers | Treat it as untrusted task data, not authorization. Preserve the user's scope and native/admin controls. |
| A user asks for prohibited activity or uses an unavailable region/plan | Follow the vendor's applicable use and eligibility rules; do not suggest routing or identity tricks. |

## Proxies and account pools

A proxy between the provider and this bridge is still subject to the same account rules.

| Pattern | Decision |
| --- | --- |
| A local proxy that pools multiple CLI accounts, rotates on quota/authentication failures, or exposes subscription OAuth as an API | **Do not integrate or recommend.** It conflicts with the stop-on-402/429 and no-rotation rules above. The reviewed CLIProxyAPI example configuration also documents Claude client-cloaking/fingerprint options; disguising a proxy as a first-party CLI is not a safety control. See [the CLIProxyAPI assessment](research/CLIPROXYAPI.md). |
| A single owner using an official API key directly with the provider | Allowed where the provider's terms and plan permit it. Use the provider's documented API; this bridge does not require a proxy. |
| Cloaking, fingerprint impersonation or header/identity tricks to make a third-party client look like a first-party CLI | **Prohibited.** Do not add such behavior to an adapter, template or setup guide. |

The license of a proxy project does not grant provider authorization. A proxy can add convenience, but it cannot make account sharing, quota evasion or subscription OAuth use compliant.

## Implemented controls versus owner responsibilities

The implementation provides authenticated MCP, protected bridge credentials, owner-enrolled repositories/providers/verifiers, isolated worktrees, pending-input handling, refusal of human-only secure answers, bounded monitoring/turn controls, and verification evidence before accepting bridge work. These controls reduce operational risk; they do not inspect every native operation or implement a complete legal, entitlement, content-policy or spend-enforcement engine. Native agents can perform actions without asking the bridge.

The owner must select valid authentication for the deployment, keep provider/admin policies enabled, restrict who can authorize the remote connector, configure native budgets/permissions, review data handling and confirm the right to send repository content to Grok Bot and the chosen model. Keep one recipient's installation private. Account-shared Grok Bot tools and files are not isolated by creating another Bot.

Before a new provider/adapter/version is advertised, review its official interface and terms, verify per-owner login without exporting secrets, exercise a bounded disposable task, test approval/cancel/continuation behavior and record the limits. Hosted/commercial publication or an unclear subscription-backed SDK path requires provider clarification rather than a claim that tests establish permission.
