# Agent engines and provider SDKs

How native agent sessions run across providers: interactions and permissions, steer and interrupt, accounts and sign-in, model parameters, session lifecycle and history, and SDK surfaces not yet adopted.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) | Medium | No | Interaction-contract gaps: saved rules, Grok project resources, Codex questions, countdown pause gaps, the unused OpenCode auto-answer branch. | Policy enforcement gaps next to a security boundary remain (Grok ignoring `projectResources: false`, unsandboxed fallbacks), and it still has the most open work in the folder. Codex now honours `projectResources: false`. |
| 2 | [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md) | Medium | No | Live close retention for Cursor and Pi, retiring the legacy close fallback once a support window exists, and a live check of Cursor's resume rows. | What is left is a live qualification run for two secondary providers (Pi waits on a usable agent-test model, 0054) and a compatibility path blocked on 0034; the browser suite now proves every lifecycle fault on the real stack. |
| 3 | [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md) | Medium | No | Auth notices and needs-auth readiness, in-app sign-in where vendors allow it, and the known multi-account switching gaps. | Users see a spawn failure or a terminal hint instead of an actionable sign-in when a login expires; the settings auth card is missing. |
| 4 | [0004-composer-model-parameters.md](0004-composer-model-parameters.md) | Medium | No | Finish moving model axes onto parameter descriptors; resolve forwarded-but-unsourced values (Codex summary/personality, `acceptEdits`, `maxBudgetUsd`). | An explicit per-turn model on an existing Codex session is silently ignored; the rest is finishing the descriptor migration. |
| 5 | [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) | Medium | No | Keep the Claude CLI warm across idle turns, retire per-turn task machinery, live model catalogue; OpenCode and Grok steer are blocked upstream. | The warm Claude CLI and steer restore need live qualification, and the per-turn task machinery still needs collapsing. OpenCode and Grok steer are blocked upstream. |
| 6 | [0006-session-titles-and-history.md](0006-session-titles-and-history.md) | Medium | No | Backend-owned title generation and the remaining fork, rewind and archive semantics per provider. | Provider parity gaps: title generation still lives in the bridges, and fork, rewind and revert are unproven on several providers. |
| 7 | [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md) | Medium | No | Vendor SDK surfaces not adopted yet, the reason for each, and the decisions that keep some out. | Two items affect users (re-arming pending Claude permissions after a reinitialize, MCP permission provenance); the rest is an optional adoption backlog. |
| 8 | [0008-opencode-v2.md](0008-opencode-v2.md) | Low | No | Deferred checkpoint for moving from the OpenCode 1.x line to OpenCode 2.x: readiness gate, API mapping, recheck procedure. Not the `/v2/client` import path. | A deferred checkpoint: nothing starts until OpenCode 2.x meets the readiness gate. |
