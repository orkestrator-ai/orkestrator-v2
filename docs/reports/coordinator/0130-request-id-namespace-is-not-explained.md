# The coordinator is told to reuse request ids but not to make new ones

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Fix the wording**: "use a new unique requestId for each new action; reuse it only to retry". Status: open.
2. **Make a collision obvious**: a refused or replayed request id says it was used before. Status: open.

### 1. Fix the wording

**Problem.** A fresh main that picks `launch-1` again collides with an earlier conversation's request.

**Context.** The namespace is `coordinatorId + requestId`, across conversations. Operator instructions already say the right thing (`control-mcp-tools.ts:569`).

**Investigation.** The coordinator's context says only "Reuse requestId on retry" (`native-agent-service.ts:1305`), the MCP instructions "Reuse requestId when retrying mutations" (`control-mcp-tools.ts:603`) and `launch_environment` "Reuse requestId when retrying" (`:1531`).

**Decisions.** None: replace the three sentences, using the operator wording.

### 2. Make a collision obvious

**Problem.** What a collision does depends on the path, and none of them tells the model to choose another id.

**Context.** Retention now lets ids older than 24 h be reused if their record was removed (`docs/architecture/coordinator.md:107-108`), which helps only after cleanup, and cleanup runs only at the limit.

**Investigation.** A changed payload throws "Coordinator request id was reused with a different payload" (`storage-coordinators.ts:269`, and at `:457`, `:486`, `:633`, `:912`). The same payload replays the old resource (`commands-registry-coordinator.ts:458-465`), which reads as a success. A collision with a different worker throws in `openWorkerDelegation` (`coordinator-worker-mail.ts:103-108`), and `send_message` swallows that (`:176-181`), so no delegation opens. The public-action hint at `control-mcp-results.ts:96` says "use a new requestId" but is not on these paths.

**Decisions.**

- **Change the error, or the namespace?**
  - **Reword the errors and mark replays (`replayed: true`) (recommended).**
    - Pros: small; keeps idempotency across a main being replaced, which a retry relies on when the conversation changes between attempts.
    - Cons: a model still has to act on the message.
  - **Namespace ids per conversation on the server, as the report's alternative.**
    - Pros: collisions across conversations disappear.
    - Cons: a retry after a main is replaced would start the work twice, and receipts in stored records need migrating.

## Related

- [Coordinator report, 4.3 (A3)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0080-full-workflow-store-is-invisible.md](0080-full-workflow-store-is-invisible.md): the same swallowed error
