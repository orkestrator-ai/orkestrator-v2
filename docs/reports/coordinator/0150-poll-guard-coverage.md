# Poll-guard coverage is uneven

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop inviting polling**: rewrite the `list_agents` description. Status: open.
2. **Harden the guard**: key on the tool and its target, use a sliding window, and cover the other status reads. Status: open.

### 1. Stop inviting polling

**Problem.** The `list_agents` description says "Read this instead of polling tabs one by one", which reads as permission to poll this.

**Context.** The async contract says not to poll at all.

**Investigation.** The sentence is at `control-mcp-tools.ts:1070`.

**Decisions.** None: replace the sentence with one saying it answers a one-off question and that wakes report changes.

### 2. Harden the guard

**Problem.** A coordinator can poll without ever being told to stop.

**Context.** The guard never withholds data; it only adds `repeatedRead` and the contract (`docs/architecture/coordinator.md:1126-1134`), so wider coverage is low risk.

**Investigation.** It is called only for `list_environments` (`control-mcp-tools.ts:996`), `read_messages` (`:2263`) and `get_message_status` (`:2339`). `list_agents`, `get_tab_state`, `get_tab_transcript`, `get_environment`, `get_multi_review` and `get_build_pipeline` have none. The key includes the raw input JSON (for example `:997`), so changing `limit` starts afresh. The window is fixed from the first read (`control-mcp-server.ts:298`, 120 s, budget 3 at `:51-52`), so reads over 40 s apart never trip it.

**Decisions.**

- **What fingerprints a repeat on the new reads?**
  - **A semantic key (tool plus target) and each read's own state fingerprint, as `environmentListFingerprint` does (recommended).**
    - Pros: a real change is never flagged; transcripts and workflows have obvious state fields.
    - Cons: one small fingerprint per tool.
  - **Tool name and target alone, ignoring state.**
    - Pros: trivially simple.
    - Cons: a legitimate check after a change gets flagged, which teaches models to ignore the field.
- **Window?**
  - **Sliding: each identical read extends it (recommended).**
    - Pros: catches slow polling, the case the report names.
    - Cons: an entry lives longer; `MAX_COORDINATOR_POLL_ENTRIES` (`:53`) already bounds them.
  - **A longer fixed window.**
    - Pros: one constant changed.
    - Cons: only moves the interval at which polling goes unseen.

## Related

- [Coordinator report, 4.3 (A4)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
