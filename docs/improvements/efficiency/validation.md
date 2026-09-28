# Evidence and validation plan

Review baseline: `88c2f9cc`, 2026-09-20–21, Bun 1.4.2.

## What ran

The review used source inspection and two short, isolated Bun commands covering
three probes. They import repository functions and operate on fabricated
in-memory messages. No application profile, provider session, Docker container,
or user transcript was opened. The probes do not persist application state.

| Probe | Observed result |
| --- | --- |
| Conditional unchanged read, 1,000 messages, no revision | 1,000 message serialization visits |
| Same unchanged read, explicit revision | 0 message serialization visits |
| Cursor trim, 100 messages of 8 KiB each, 256 KiB test ceiling | 31 retained; 4,585 message serialization visits |
| Shared trim helper, same inputs and ceiling | 31 retained; 100 message serialization visits |
| Cursor streaming, 600 separate 1 KiB reasoning parts, no reads | 600 retained parts; 712,206 serialized bytes |
| Same Cursor state after read-side bounding | 220 retained parts; 261,256 serialized bytes |

The serialization counts are deterministic evidence of repeated work, not a
production benchmark. The Cursor ceiling was lowered through its existing
testable configuration; 600 parts also exceeds the unchanged production
512-part ceiling. The generated IDs and timestamps are fixed-length fields;
exact serialized byte totals are tied to the baseline representation.

No full test suite, browser performance test, or remote bandwidth benchmark ran:
the deliverable changes documentation only, and passing functional tests would
not establish the size of these efficiency costs. Implementation should add
focused regressions and then follow the repository's
[testing guide](../../development/testing-guide.md).

## Reproduce the serialization probes

Run from the repository root with the pinned Bun runtime. The environment
override applies only to this command.

```bash
CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES=262144 bun - <<'EOF'
import { bridgeTranscriptUpdate } from './packages/protocol/src/progressive-transcript.ts';
import { boundTranscriptResponse } from './packages/protocol/src/transcript-window.ts';
import { boundTranscript } from './bridges/cursor-bridge/src/transcript.ts';

let serializations = 0;
function messages(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i), content: 'x'.repeat(8192), parts: [],
    toJSON() {
      serializations++;
      return { id: this.id, content: this.content, parts: this.parts };
    }
  }));
}
const history = messages(1000);
const base = {
  sessionIdentity: 'synthetic', generation: 1, contentEpoch: 1,
  limit: 100, targetBytes: 524288, complete: true
};
for (const revision of [undefined, 1]) {
  const options = { ...base, ...(revision === undefined ? {} : { revision }) };
  const first = bridgeTranscriptUpdate(history, options);
  serializations = 0;
  const result = bridgeTranscriptUpdate(history, { ...options, knownToken: first.token });
  console.log({ probe: 'unchanged', revision, status: result.status, serializations });
}

serializations = 0;
const state = {
  messages: messages(100), droppedMessages: 0, droppedParts: 0,
  transcriptTruncated: false, uncheckedTranscriptBytes: 1
};
boundTranscript(state);
console.log({ probe: 'cursor_trim', kept: state.messages.length, serializations });

serializations = 0;
const shared = boundTranscriptResponse(messages(100), 262144, { envelopeReserveBytes: 0 });
console.log({ probe: 'shared_trim', kept: shared.messages.length, serializations });
EOF
```

The instrumentation uses `toJSON` only to count visits while returning the same
message fields. It does not run the full Claude HTTP route; the source trace in
E03 establishes that Claude selects the no-revision helper branch.

## Reproduce background Cursor growth

This uses the actual translator with the minimal state required by the two
reasoning-update variants. It tests the producer boundary, not an end-to-end
SDK run or a desktop environment switch.

```bash
CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES=262144 bun - <<'EOF'
import { applyInteractionUpdate } from './bridges/cursor-bridge/src/translate.ts';
import { boundTranscriptForRead } from './bridges/cursor-bridge/src/transcript.ts';

const state = {
  messages: [], composer: {}, openTextParts: new Map(),
  uncheckedTranscriptBytes: 0, revision: 0, droppedMessages: 0,
  droppedParts: 0, transcriptTruncated: false
};
for (let i = 0; i < 600; i++) {
  applyInteractionUpdate(state, { type: 'thinking-delta', text: 'x'.repeat(1024) });
  applyInteractionUpdate(state, { type: 'thinking-completed' });
}
console.log({
  phase: 'unobserved_stream', parts: state.messages[0].parts.length,
  bytes: Buffer.byteLength(JSON.stringify(state.messages))
});
boundTranscriptForRead(state);
console.log({
  phase: 'after_read_bound', parts: state.messages[0].parts.length,
  bytes: Buffer.byteLength(JSON.stringify(state.messages))
});
EOF
```

## Measurements needed before architectural changes

Use synthetic histories in an isolated test profile. Cover Claude, Codex,
OpenCode, Cursor, Pi, and ACP, distinguishing provider-native storage costs
from Orkestrator-owned normalization and transport costs.

| Scenario | Vary | Record |
| --- | --- | --- |
| Idle native session | 10/100/1,000+ source messages; cached vs cold | Requests, source reads, serialization visits, backend CPU |
| Long streaming turn | Many small parts; one large text/tool part | Event-loop lag, peak heap, bytes per changed part, UI input latency |
| Heavy artifacts | Large tool result/diff and inline image | Raw bridge bytes, projected bytes, detail fetches, hydration retries |
| History paging | First page, repeated pages, near client history cap | Time to page, source bytes read, normalization/hash work |
| Background environments | Several active agents with no mounted transcript | Per-bridge memory growth, task continuity, exact rehydration |
| Shared persistence | 1/32/128 tails; multiple long pipelines | File bytes read/written, backup I/O, lock wait, checkpoint age |
| Many sessions/clients | Multiple tabs, browsers, and HTTP bridge sessions | Shared-read hit rate, activity requests, concurrency, sweep duration |
| Remote delivery | Actual supported proxy, slow client, reconnect | Encoded and decoded bytes, first-update latency, replay/reset rate |
| Files and terminals | Quiet/changed tree; noisy terminals; reconnect burst | Scans/execs, snapshot serialization, backlog and recovery frequency |

The existing
[`ProgressiveReadMetrics`](../../../apps/backend/src/core/native-agent-progressive-metrics.ts)
stores a bounded 256 samples and declares source/normalization/scheduler fields,
but current projection call sites mainly report overall read duration, tier,
and outcome. Add actual phase measurements at the work boundaries rather than
assuming those optional fields already provide a breakdown. Gateway encoded
wire metrics are useful but cannot reveal upstream parsing or disk rewrites.

Use histograms/counters with bounded labels such as provider and read domain.
Count sizes and operations without recording payloads or unbounded path/session
labels. Measure p50/p95 latency and peak retained memory over repeated runs;
do not derive a production speedup from a single microbenchmark.

## Acceptance criteria for the first implementation wave

- Unchanged Claude transcript reads visit no message bodies.
- Cursor enforces count/byte display bounds without a reader and without
  terminating background work. Transient growth has a documented finite bound.
- Cursor journal durability failures prevent dispatch instead of reporting a
  successful persistence barrier.
- Trimming serialization visits grow linearly with input messages/parts.
- Updating one persisted tail does not parse, checksum, or rewrite every tail.
- Pipeline control snapshots do not grow with full display transcripts; durable
  inputs, structured reports, and restart semantics remain intact.
- Retained historical pages are not reserialized for a tail-only UI update.
- Upstream history bytes are proportional to the requested range where the
  provider supports it, with explicit measured fallbacks where it does not.

## Required recovery checks

1. Start work, leave the environment, let it progress or finish, return, and
   verify messages, tool state, pending questions/approvals, queue controls, and
   completion status.
2. Interrupt the client stream, exceed replay retention, and reconnect. Require
   explicit snapshot reconciliation on a revision gap or generation change.
3. Rewind/replace history after pages have been cached. Reject old cursors and
   discard stale content rather than merging incompatible histories.
4. Restart bridges/backend while a dispatch is prepared or ambiguous. Never
   auto-retry merely because a cache or journal record is absent.
5. Exercise slow consumers and compression admission failures. No unbounded
   queues, silent authoritative event drops, or provider stdout backpressure.
6. Expire a deferred detail entry while the UI retains its row. Recover the
   exact detail or show an explicit unavailable result; never substitute a
   different revision's content.

Follow [isolated agent testing](../../development/agent-testing.md) for browser,
Electron, Docker, and remote-path validation. Keep all performance artifacts
free of user prompts, file/tool contents, secrets, and attachment data.
