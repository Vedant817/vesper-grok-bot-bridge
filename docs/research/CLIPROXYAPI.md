# CLIProxyAPI assessment

Reviewed **23 October 2026**: [repository](https://github.com/router-for-me/CLIProxyAPI), [example configuration](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml), [MIT license](https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE), [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), and [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms). This is an engineering deployment review, not legal advice or vendor approval. Policies, plans and enforcement can change.

## Decision

**Do not integrate CLIProxyAPI.** It is not a ban-safety layer. Its documented account pooling, quota/authentication failover, and Claude client-cloaking options conflict with this project's provider policy and, for Claude, with Anthropic's published authentication rules. The bridge should continue to use each owner's native authentication and direct CLI/ACP execution. No dependency, installer, adapter, template, sample configuration or supported workflow will be added.

## What the project provides

CLIProxyAPI is an MIT-licensed local proxy that exposes OpenAI-, Gemini-, Claude-, Codex- and Grok-compatible API surfaces for CLI clients. Its README advertises:

- multiple CLI accounts with round-robin load balancing for Gemini, OpenAI, Claude and Grok;
- OAuth login flows for CLI accounts;
- a management API and client API keys;
- optional remote management.

That is a credential-pooling gateway. The software license permits use of the code; it does not grant permission from any model provider to pool accounts, route subscription credentials, or resell access.

## Documented behavior that conflicts with this project

| CLIProxyAPI documentation | This project's policy |
| --- | --- |
| Round-robin, weighted-round-robin or fill-first routing across multiple credentials; `max-retry-credentials: 0` tries all available credentials. | One owner, one account per provider; no pooling or rotation. |
| `request-retry: 3`, with additional rounds on HTTP 403, 408, 429, 500, 502, 503 and 504; cooldown and failover. | Stop on 401/403 and 402/429; report the redacted error; do not rotate accounts or keys, or switch models automatically. |
| Claude `cloak` modes, `fingerprint-profile: "claude-code-cli"`, and `sensitive-words` obfuscation. | No spoofing, fingerprint impersonation, approval bypass or token extraction. |
| Default `server.host: ""` binds all interfaces; remote management can be enabled. | The bridge exposes only a loopback listener behind an authenticated HTTPS tunnel; control and credential surfaces stay private. |

These are not theoretical: the example configuration is the project's own recommended starting point. A deployment that removes all of them is no longer the multi-account product the README describes, and it still adds a credential store and HTTP gateway that this bridge does not need.

## Provider-specific evidence

**Anthropic / Claude.** Anthropic's legal and compliance page states that OAuth authentication is intended exclusively for purchasers of Claude Free/Pro/Max/Team/Enterprise plans and for ordinary use of Claude Code and other native Anthropic applications. Developers building products or services that interact with Claude are directed to API-key authentication. Anthropic does not permit third-party developers to offer Claude.ai login, route requests through Free/Pro/Max credentials on behalf of their users, or collect, store or intermediate Claude.ai credentials or session tokens. The Consumer Terms separately prohibit sharing account credentials and automated or non-human access except through an API key or as explicitly permitted, and prohibit bypassing protective measures.

A proxy that logs in with a subscription OAuth token and disguises itself as Claude Code is in direct tension with those rules. Rotating to another account after a 402/429 does not cure that; it makes the pattern harder to defend.

**OpenAI / Codex, xAI / Grok Build and others.** Their contracts differ, and this document does not collapse them into one rule. The project's [provider policy](../PROVIDER_POLICY.md) already requires per-owner native authentication, API-key use where the provider directs it, no account sharing, and no automatic rotation. CLIProxyAPI's pooling model does not satisfy those requirements for any provider, even where a single-account local proxy might be technically possible.

## Security and operational footprint

- It stores provider OAuth or credential material and client API keys. That is another secret store to protect, back up and revoke.
- Its default listener is not loopback-only. A misconfiguration can expose an account gateway on a LAN or public interface.
- Its management API is an additional privileged surface, even when remote management is disabled by default.
- Client cloaking and obfuscation make requests look like a different client. That is an evasion feature, not an accountability or safety feature.
- It adds a process, configuration and upgrade path that the bridge would have to monitor. The bridge already spawns the native CLIs; a proxy layer adds no task-routing, approval or verification capability.

## What would change the decision

Only a provider's explicit written authorization for the specific pooling or relay pattern, or a deployment that uses official API keys for a single owner and has been confirmed by the provider, could make a proxy reviewable. Even then it would be a separate product decision: this bridge does not need the proxy to start tasks, continue native sessions, collect verification evidence or route approvals. No such authorization is present in the sources reviewed here.

## Safe alternatives

1. Use each provider's native login or API key under the owner's own agreement.
2. Keep one owner and one account per provider; never lend, pool or rotate credentials.
3. Stop on authentication, quota or policy failures. Wait for the owner or the provider's reset; do not retry with another account.
4. Keep MFA, CAPTCHA, payment and security approvals human.
5. Use Tailscale or another tunnel only for the network path; it does not change provider authorization. See [the standalone remote-access guidance](../STANDALONE.md).
6. Re-review the provider's terms when the plan, region, deployment model or CLI version changes.

## Evidence limits

This assessment read the public README, example configuration and license, and Anthropic's published terms. It did not run CLIProxyAPI, enroll a provider account or test a provider's enforcement. It is not a legal opinion. The absence of a ban in one deployment is not evidence of permission; a term in a contract is not a prediction of enforcement. The owner bears the account and contract risk.
