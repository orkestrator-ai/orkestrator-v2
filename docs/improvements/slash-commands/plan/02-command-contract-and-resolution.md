# 02 — Define command identity, snapshots, and resolution

Status: proposed. Dependencies: 01. [Index](00-index.md).

## Owners

[native-agent.ts](../../../../packages/protocol/src/native-agent.ts),
[agent-slash-commands.ts](../../../../packages/protocol/src/agent-slash-commands.ts),
their tests, gateway validators/projection patches, and
[agent-provider-contract.ts](../../../../apps/backend/src/core/agent-provider-contract.ts).
Add small dedicated protocol modules if necessary; do not further inflate the
already large service files.

## Public and private data

Define an additive, versioned descriptor. Suggested fields are design names:

| Field | Meaning and rules |
| --- | --- |
| `id` | Opaque stable identity within provider/environment/session authority; independent of description or row order |
| `name` | Display name, preserving provider spelling and namespaces |
| `insertText` | Exact insertion token; can be `$name` for a Codex skill |
| `aliases` | Searchable invocation spellings, each resolving to the same binding |
| `executionKind` | Closed enum: provider-prompt, provider-command, structured-skill, bridge-template, session-action |
| `source` / provenance | Existing source category; optional verified origin scope and provider label; unknown remains unknown |
| `availability` | Available/unavailable plus bounded reason code and message |
| `inputPolicy` | Argument requirement, attachment kinds, annotation/handoff support, busy-state behavior |
| `bindingRevision` | Changes when identity/execution meaning changes, not when presentation metadata changes |

Do not overload the existing `scope: global | session` with user/project
ownership. Define origin scope separately if needed. Keep legacy fields during
migration, with explicit meaning and a single normalization function.

A private registry maps `id` to canonical provider name, trusted skill path,
template identity/fingerprint, or supported action. Never accept these private
bindings from the browser. IDs are lookup keys, not permission grants; validate
environment, session, generation, availability, and current execution policy.

Wrap the list in a proposed catalogue snapshot carrying authority/generation,
monotonic revision, status (`loading`, `ready`, `stale`, `unavailable`,
`unsupported`), fetched time, truncation/completeness, and commands. A ready
empty list is distinct from failure. Errors are bounded codes, not raw SDK dumps.

## Parsing and resolution algorithm

1. Parse the leading token without modifying its bytes or the argument suffix.
   Record offsets and raw text. Normalize only separate lookup keys according
   to the adapter's declared case rules. Do not shell-tokenize free text.
2. Recognize whitespace separators consistently, including tabs/newlines.
   Preserve the argument suffix after the defined separator rule, including
   internal newlines and trailing spaces. Document any normalization needed
   solely for a provider's native transport.
3. If literal mode is selected, skip command matching. Absolute paths and
   unknown tokens do not become unavailable commands merely because of `/`.
4. If an explicit descriptor ID is present, require token compatibility and the
   same binding revision. Resolve it directly against authoritative state.
5. For typed invocation, prefer a canonical exact match, then an unambiguous
   alias under provider rules. Case-insensitive search does not imply
   case-insensitive execution. Return ambiguity rather than choosing by sort.
6. Evaluate state/input policies before prompt shaping or queue insertion.
7. Return a typed resolution: literal prompt, executable binding, unavailable,
   stale selection, ambiguous name, or invalid arguments. No success result
   should require a downstream layer to repeat name guessing.

## Collision policy

- Preserve provider-established precedence inside one provider. Pi extensions
  shadow templates according to its SDK; display that effective winner.
- A descriptor may expose a namespaced alternate only if the executor can
  actually address it. A made-up alias must not imply access to a shadowed row.
- Preserve provider commands when an identically named Orkestrator action is
  unavailable. Replace the current unconditional `/steer` deletion.
- Reserve `/steer` for the qualified runtime behavior only with an explicit,
  documented collision policy; offer an application-qualified action spelling
  if needed. Do not silently change existing provider command behavior.
- Treat Codex `/help` and `/models` discovery/execution precedence identically.
- Deduplicate descriptors by identity, not lowercase presentation alone.

## Bounds and compatibility

Begin with existing ceilings: 512 rows, 256-byte names/IDs, 16 aliases,
1,000-byte descriptions, 512-byte hints, and 512 KiB catalogue wire budget.
These are proposed UTF-8 byte ceilings; implement byte-aware checks rather than
assuming string length is bytes. Reject an overlong invocation identity rather
than truncating it into a different executable command. Presentation text may
be safely truncated with a marker. Bound aggregate aliases and total snapshot
memory, not only individual fields.

Add protocol negotiation for enhanced catalogue/execution support. Continue
reading legacy `commands` arrays in a labelled legacy mode. Do not derive new
execution authority from old untyped rows. Define omission/removal semantics in
projection patches so an empty replacement can clear an old catalogue.

## Required tests and exit criteria

Cover empty lists, malformed rows, invalid discriminants, UTF-8 limits,
duplicate IDs, alias collisions, namespaced names, case distinctions, leading
paths, newline/tab arguments, literal mode, stale binding revisions, disabled
commands, and action/provider collisions. Round-trip public snapshots through
actual validators and projection patch transport. Prove that no public payload
contains skill paths or template bodies and that old clients still decode the
legacy projection. Freeze these semantics before adapter implementation.
