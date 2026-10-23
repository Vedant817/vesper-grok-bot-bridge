# Recipient acceptance checks

Replace the bracketed inputs with your own enrolled values. Keep each request's returned IDs. These are manual, observable checks, not evidence that your installation already passed.

1. **Discover only:** “Use [my connector] and discover coding providers/models. Do not launch any work. Report the exact IDs, authentication limitations and enrolled import capabilities.” Verify the response against your installed CLI.
2. **Session loop:** “In [my enrolled disposable Git repository], use [exact provider] and [exact model]. Start one no-edit session that returns `DEMO_READY`. Read it, continue that same session to return `DEMO_CONTINUED`, then cancel. Do not use tools, change files, install anything, switch models or retry uncertain work. Report both bridge/native session IDs, actual responses and final state.” Check both turns belong to the same native ID, the worktree is clean and nothing is pending.
3. **Real coding:** In a disposable project with an owner-enrolled test command, ask it to change one implementation file, inspect the diff and run `agent_verify`. If a check fails, it must send a concrete correction to the same session. `agent_finish` must use current passing evidence; a worker's success message alone is insufficient. Confirm tests and verifier configuration were not weakened.
4. **Quota/auth error:** If one occurs, require the exact redacted error and a pause. Do not trigger errors by consuming quota, changing credentials or switching accounts. No replacement session or model is permitted merely to hide the failure.
5. **Restart:** Only after all work is terminal, restart your own bridge. Ask the Bot to discover and read the retained session. OAuth should remain usable until expiry/revocation; calls overlapping startup may fail. Reconcile before retrying mutations. This does not test a physical reboot.

Native Grok Bot approval cards can still appear. Review only actions you delegated. Configure narrow native rules yourself if appropriate; do not grant blanket permissions to pass a demo.
