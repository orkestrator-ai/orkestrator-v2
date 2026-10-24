/**
 * Rich-transcript performance gate fixture (`/rich-transcript-perf`).
 *
 * Renders the real transcript stack — `NativeChatShell` (which mounts
 * `VirtualizedMessageList` + `NativeMessage`) with the real `NativeComposeBar`
 * whose text state lives in the same component as the shell, as the agent tab
 * controller holds it — over a seeded synthetic transcript of 3,000 messages:
 * 100 rich blocks (code fences in mixed languages, Mermaid and chart fences,
 * tables, details, callouts, inline data-URL images), deferred image parts,
 * JSON payloads and published artifact parts, plus a response that streams
 * tokens into a code fence at a steady rate on request.
 *
 * Backend calls are answered deterministically and instantly by a fake
 * `window.orkestrator.invoke`. All content is synthetic.
 *
 * The same file must build against the pre-rich-transcript baseline commit,
 * so modules that only exist after the change are feature-detected with
 * `import.meta.glob` (an empty record when the file is absent) and every
 * exposed counter is content-free. Driven by `e2e/perf/rich-transcripts-perf.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";
import type {
  NativeMessage as Message,
  NativeMessagePart,
} from "../../apps/web/src/lib/chat/native-message-types";

// ---------------------------------------------------------------------------
// Feature-detected modules (absent at the baseline commit).

type SchedulerModule = typeof import("../../apps/web/src/lib/chat/rich-render-cache");
type HighlighterModule = typeof import("../../apps/web/src/lib/chat/highlighter/client");
type CapabilitiesModule =
  typeof import("../../apps/web/src/hooks/useTranscriptArtifactCapabilities");
type IdentityModule = typeof import("../../apps/web/src/lib/chat/rich-identity");
type ArtifactRequestsModule = typeof import("../../apps/web/src/lib/chat/artifact-requests");
type ViewStoreModule = typeof import("../../apps/web/src/stores/richContentViewStore");

function optionalModule<T>(modules: Record<string, unknown>): T | null {
  const values = Object.values(modules);
  return values.length > 0 ? (values[0] as T) : null;
}

const schedulerModule = optionalModule<SchedulerModule>(
  import.meta.glob("../../apps/web/src/lib/chat/rich-render-cache.ts", { eager: true }),
);
const highlighterModule = optionalModule<HighlighterModule>(
  import.meta.glob("../../apps/web/src/lib/chat/highlighter/client.ts", { eager: true }),
);
const capabilitiesModule = optionalModule<CapabilitiesModule>(
  import.meta.glob("../../apps/web/src/hooks/useTranscriptArtifactCapabilities.ts", {
    eager: true,
  }),
);
const identityModule = optionalModule<IdentityModule>(
  import.meta.glob("../../apps/web/src/lib/chat/rich-identity.ts", { eager: true }),
);
const artifactRequestsModule = optionalModule<ArtifactRequestsModule>(
  import.meta.glob("../../apps/web/src/lib/chat/artifact-requests.ts", { eager: true }),
);
const viewStoreModule = optionalModule<ViewStoreModule>(
  import.meta.glob("../../apps/web/src/stores/richContentViewStore.ts", { eager: true }),
);

// ---------------------------------------------------------------------------
// Content-free probes.

interface PerfCounters {
  rowMounts: number;
  richBlockMounts: number;
  codeBlockMounts: number;
  highlighterInvocations: number;
  workersCreated: number;
  workersTerminated: number;
  backendCalls: Record<string, number>;
  unexpectedCommands: number;
  streamTicks: number;
  streamChars: number;
}

const counters: PerfCounters = {
  rowMounts: 0,
  richBlockMounts: 0,
  codeBlockMounts: 0,
  highlighterInvocations: 0,
  workersCreated: 0,
  workersTerminated: 0,
  backendCalls: {},
  unexpectedCommands: 0,
  streamTicks: 0,
  streamChars: 0,
};

// Count module workers (the highlighter) without changing their behaviour.
const NativeWorker = window.Worker;
if (NativeWorker && !(NativeWorker as unknown as { perfCounted?: boolean }).perfCounted) {
  class CountedWorker extends NativeWorker {
    static perfCounted = true;
    private perfTerminated = false;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      counters.workersCreated++;
    }
    override terminate(): void {
      if (!this.perfTerminated) {
        this.perfTerminated = true;
        counters.workersTerminated++;
      }
      super.terminate();
    }
  }
  window.Worker = CountedWorker;
}

// Count highlighter invocations by wrapping the real (worker) backend.
if (highlighterModule) {
  const real = highlighterModule.highlightBackend();
  if (real) {
    highlighterModule.setHighlightBackend({
      highlight(input, signal) {
        counters.highlighterInvocations++;
        return real.highlight(input, signal);
      },
      reset() {
        real.reset?.();
      },
    });
  }
}

function installMountProbe(): void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.hasAttribute("data-item-index")) counters.rowMounts++;
        if (node.matches("[data-rich-block]")) counters.richBlockMounts++;
        counters.richBlockMounts += node.querySelectorAll("[data-rich-block]").length;
        if (node.matches("pre")) counters.codeBlockMounts++;
        counters.codeBlockMounts += node.querySelectorAll("pre").length;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Seeded synthetic content.

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const WORDS = [
  "render",
  "window",
  "buffer",
  "schedule",
  "token",
  "stream",
  "layout",
  "segment",
  "cache",
  "budget",
  "worker",
  "queue",
  "diagram",
  "series",
  "payload",
  "fixture",
  "virtual",
  "history",
  "viewport",
  "commit",
  "measure",
  "frame",
  "bounded",
  "result",
];

function words(random: () => number, count: number): string {
  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]!).join(" ");
}

function sentence(random: () => number): string {
  const text = words(random, 8 + Math.floor(random() * 10));
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(random: () => number): string {
  return Array.from({ length: 2 + Math.floor(random() * 3) }, () => sentence(random)).join(" ");
}

function tsCode(random: () => number, r: number, lines: number): string {
  const out = [`export interface Sample${r} {`, "  id: string;", "  values: number[];", "}", ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `export function compute${r}_${i}(input: Sample${r}): number {`,
      `  const scale = ${(random() * 10).toFixed(3)};`,
      "  return input.values.reduce((sum, value) => sum + value * scale, 0);",
      "}",
      "",
    );
  }
  return out.join("\n");
}

function pyCode(random: () => number, r: number, lines: number): string {
  const out = [
    "import math",
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    `class Row${r}:`,
  ];
  out.push("    name: str", "    weight: float", "");
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `def score_${r}_${i}(rows: list[Row${r}]) -> float:`,
      `    factor = ${(random() * 5).toFixed(2)}`,
      "    return sum(math.sqrt(row.weight) * factor for row in rows)",
      "",
    );
  }
  return out.join("\n");
}

function rustCode(random: () => number, r: number, lines: number): string {
  const out = ["use std::collections::HashMap;", ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `pub fn tally_${r}_${i}(items: &[&str]) -> HashMap<String, usize> {`,
      "    let mut counts = HashMap::new();",
      "    for item in items {",
      `        *counts.entry(item.to_string()).or_insert(${Math.floor(random() * 3)}) += 1;`,
      "    }",
      "    counts",
      "}",
      "",
    );
  }
  return out.join("\n");
}

function bashCode(random: () => number, r: number, lines: number): string {
  const out = ["#!/usr/bin/env bash", "set -euo pipefail", ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `for file in build/out-${r}-${i}/*.log; do`,
      `  grep -c "${words(random, 1)}" "$file" || true`,
      "done",
    );
  }
  return out.join("\n");
}

function goCode(random: () => number, r: number, lines: number): string {
  const out = ["package sample", "", 'import "fmt"', ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `func Describe${r}x${i}(n int) string {`,
      `\treturn fmt.Sprintf("value-%d", n*${Math.floor(random() * 9) + 1})`,
      "}",
      "",
    );
  }
  return out.join("\n");
}

const MERMAID_SOURCES = [
  "flowchart TD\n  A[Request] --> B{Cached?}\n  B -- yes --> C[Serve]\n  B -- no --> D[Render]\n  D --> E[Store]\n  E --> C",
  "sequenceDiagram\n  participant UI\n  participant Worker\n  UI->>Worker: tokenize\n  Worker-->>UI: lines\n  UI->>UI: paint",
  "flowchart LR\n  Queue --> Lane1[Highlight lane]\n  Queue --> Lane2[Diagram lane]\n  Lane1 --> Cache\n  Lane2 --> Cache",
  "stateDiagram-v2\n  [*] --> Pending\n  Pending --> Running\n  Running --> Settled\n  Running --> Failed\n  Settled --> [*]",
  "flowchart TD\n  Source --> Parse --> Validate --> Publish\n  Validate --> Reject",
];

function chartSpec(random: () => number, r: number): string {
  const categories = ["alpha", "beta", "gamma", "delta", "epsilon"];
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "bar",
      title: `Synthetic series ${r}`,
      description: "Synthetic fixture values.",
      sourceNotes: ["All numbers are synthetic test data."],
      xAxis: { kind: "category", label: "Group" },
      yAxis: { label: "Count", unit: "items" },
      categories: categories.map((id) => ({ id, label: id })),
      series: ["a", "b"].map((id) => ({
        id,
        label: `Run ${id.toUpperCase()}`,
        points: categories.map((categoryId) => ({
          categoryId,
          value: Math.round(random() * 100),
        })),
      })),
    },
    null,
    2,
  );
}

function table(random: () => number, r: number): string {
  const rows = ["| Key | Owner | Count | Ratio | Note |", "| --- | --- | ---: | ---: | --- |"];
  for (let i = 0; i < 10; i++) {
    rows.push(
      `| k-${r}-${i} | ${words(random, 1)} | ${Math.floor(random() * 1000)} | ${random().toFixed(3)} | ${words(random, 3)} |`,
    );
  }
  return rows.join("\n");
}

function jsonPayload(random: () => number, r: number): Record<string, unknown> {
  return {
    id: `payload-${r}`,
    status: "ok",
    metrics: Array.from({ length: 12 }, (_, i) => ({
      name: `${words(random, 1)}-${i}`,
      value: Math.round(random() * 10_000) / 100,
      tags: [words(random, 1), words(random, 1)],
    })),
    nested: { depth: 2, ok: true, window: { start: r, end: r + 40 } },
  };
}

let imageUrls: string[] = [];

function syntheticImages(): string[] {
  if (imageUrls.length > 0) return imageUrls;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext("2d");
  imageUrls = Array.from({ length: 4 }, (_, variant) => {
    if (!context) return "data:image/png;base64,";
    const gradient = context.createLinearGradient(0, 0, 480, 270);
    gradient.addColorStop(0, ["#1e3a8a", "#065f46", "#7c2d12", "#581c87"][variant]!);
    gradient.addColorStop(1, ["#93c5fd", "#6ee7b7", "#fdba74", "#d8b4fe"][variant]!);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 480, 270);
    context.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = 0; i < 12; i++) {
      context.fillRect(
        20 + i * 37,
        250 - ((i * 17 + variant * 13) % 200),
        24,
        (i * 17 + variant * 13) % 200,
      );
    }
    return canvas.toDataURL("image/png");
  });
  return imageUrls;
}

const MESSAGE_COUNT = 3_000;
const RICH_EVERY = 30; // 100 rich blocks
const IMAGE_EVERY = 60; // 50 deferred image parts
const JSON_EVERY = 45; // ~67 JSON payloads
const ARTIFACT_EVERY = 150; // 20 artifact parts
const ENVIRONMENT_ID = "perf-environment";
const SESSION_KEY = "perf-environment:perf-session";
const BACKEND_ID = "perf-backend";

function richMarkdown(random: () => number, r: number): string {
  const lead = paragraph(random);
  switch (r % 10) {
    case 0:
      return `${lead}\n\n\`\`\`ts\n${tsCode(random, r, 36)}\n\`\`\``;
    case 1:
      return `${lead}\n\n\`\`\`python\n${pyCode(random, r, 28)}\n\`\`\``;
    case 2:
      return `${lead}\n\n\`\`\`rust\n${rustCode(random, r, 30)}\n\`\`\``;
    case 3:
      return `${lead}\n\n\`\`\`bash\n${bashCode(random, r, 18)}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(jsonPayload(random, r), null, 2)}\n\`\`\``;
    case 4:
      return `${lead}\n\n\`\`\`mermaid\n${MERMAID_SOURCES[Math.floor(r / 10) % MERMAID_SOURCES.length]}\n\`\`\``;
    case 5:
      return `${lead}\n\n\`\`\`chart\n${chartSpec(random, r)}\n\`\`\``;
    case 6:
      return `${lead}\n\n${table(random, r)}\n\n${paragraph(random)}`;
    case 7:
      return `${lead}\n\n<details>\n<summary>Build log ${r}</summary>\n\n\`\`\`bash\n${bashCode(random, r, 14)}\n\`\`\`\n\n</details>`;
    case 8:
      return `> [!NOTE]\n> ${sentence(random)}\n\n${lead}\n\n> [!WARNING]\n> ${sentence(random)}\n\n- ${sentence(random)}\n- ${sentence(random)}`;
    default:
      return `${lead}\n\n![Synthetic plot ${r}](${syntheticImages()[r % 4]})\n\n\`\`\`go\n${goCode(random, r, 20)}\n\`\`\``;
  }
}

function artifactRef(k: number) {
  const kind = k % 2 === 0 ? "chart" : "mermaid";
  const suffix = String(k).padStart(8, "0");
  return {
    schemaVersion: 1 as const,
    artifactId: `art_perf${suffix}`,
    revision: 1,
    publicationId: `pub_perf${suffix}`,
    kind,
    title: `Synthetic ${kind} artifact ${k}`,
    summary: `Synthetic ${kind} artifact used by the performance gate.`,
    provenance: { backendId: BACKEND_ID, origin: "agent" as const },
  };
}

function textMessage(id: string, role: Message["role"], content: string, at: number): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0) + at * 60_000).toISOString(),
    parts: [{ type: "text", content }],
  };
}

function buildTranscript(): Message[] {
  const random = seeded(0x5eed);
  const messages: Message[] = [];
  let richIndex = 0;
  let imageIndex = 0;
  let jsonIndex = 0;
  let artifactIndex = 0;
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const id = `perf-msg-${i}`;
    const at = i;
    if (i % ARTIFACT_EVERY === 75) {
      const k = artifactIndex++;
      const ref = artifactRef(k);
      const summary = `Published ${ref.title}.`;
      messages.push({
        ...textMessage(id, "assistant", summary, at),
        parts: [
          { type: "text", content: paragraph(random) },
          {
            type: "artifact",
            content: summary,
            artifact: ref,
            publishedAt: new Date(Date.UTC(2026, 9, 1) + at * 60_000).toISOString(),
            conversationSequence: k + 1,
          } as unknown as NativeMessagePart,
        ],
      });
      continue;
    }
    if (i % RICH_EVERY === 7) {
      messages.push(textMessage(id, "assistant", richMarkdown(random, richIndex++), at));
      continue;
    }
    if (i % IMAGE_EVERY === 21) {
      const n = imageIndex++;
      messages.push({
        ...textMessage(id, "assistant", "Generated the plot.", at),
        parts: [
          { type: "text", content: "Generated the plot." },
          {
            type: "image",
            content: `synthetic-plot-${n}.png`,
            imageSource: "generated",
            detailRef: `perf-image-${n}`,
          } as NativeMessagePart,
        ],
      });
      continue;
    }
    if (i % JSON_EVERY === 11) {
      const n = jsonIndex++;
      const payload = JSON.stringify(jsonPayload(random, n), null, 2);
      messages.push(
        n % 2 === 0
          ? {
              ...textMessage(id, "assistant", "", at),
              parts: [
                {
                  type: "tool-invocation",
                  content: "",
                  toolName: "fetch_metrics",
                  toolUseId: `perf-tool-${n}`,
                  toolArgs: { window: n, limit: 12 },
                  toolState: "success",
                  toolOutput: payload,
                },
                { type: "text", content: sentence(random) },
              ],
            }
          : textMessage(id, "assistant", payload, at),
      );
      continue;
    }
    if (i % 2 === 0) {
      messages.push(textMessage(id, "user", sentence(random), at));
    } else {
      const body =
        random() < 0.3
          ? `${paragraph(random)}\n\n- \`${words(random, 1)}\` ${sentence(random)}\n- ${sentence(random)}`
          : `${paragraph(random)}\n\n${paragraph(random)}`;
      messages.push(textMessage(id, "assistant", body, at));
    }
  }
  padToRetainedBytes(messages, random);
  return messages;
}

/**
 * `?retainedMiB=N` grows the same 3,000 messages to about N MiB of encoded
 * JSON by appending paragraphs to plain assistant replies, so a large retained
 * history stays under the client's 4,096-message cap (`CLIENT_HISTORY_*` in
 * `useNativeAgentSession.ts`). Without it the transcript is unchanged.
 */
const RETAINED_TARGET_BYTES =
  Number(new URLSearchParams(window.location.search).get("retainedMiB") ?? 0) * 1024 * 1024;

function encodedBytes(message: Message): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

function padToRetainedBytes(messages: Message[], random: () => number): void {
  if (!(RETAINED_TARGET_BYTES > 0)) return;
  const plain = messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.parts.length === 1 &&
      !message.content.includes("```"),
  );
  if (plain.length === 0) return;
  let total = messages.reduce((sum, message) => sum + encodedBytes(message), 0);
  for (let round = 0; total < RETAINED_TARGET_BYTES && round < 64; round += 1) {
    for (const message of plain) {
      if (total >= RETAINED_TARGET_BYTES) break;
      const before = encodedBytes(message);
      const content = `${message.content}\n\n${paragraph(random)}`;
      message.content = content;
      message.parts = [{ type: "text", content }];
      total += encodedBytes(message) - before;
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic backend.

const MERMAID_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
  '<rect x="10" y="10" width="90" height="40" rx="6" fill="#1f2937" stroke="#9ca3af"/>',
  '<rect x="215" y="10" width="90" height="40" rx="6" fill="#1f2937" stroke="#9ca3af"/>',
  '<rect x="110" y="120" width="100" height="40" rx="6" fill="#1f2937" stroke="#9ca3af"/>',
  '<path d="M100 30 L215 30 M160 50 L160 120" stroke="#9ca3af" fill="none"/>',
  '<text x="55" y="35" text-anchor="middle" fill="#e5e7eb" font-size="12">Start</text>',
  '<text x="260" y="35" text-anchor="middle" fill="#e5e7eb" font-size="12">Check</text>',
  '<text x="160" y="145" text-anchor="middle" fill="#e5e7eb" font-size="12">Done</text>',
  "</svg>",
].join("");

const SHA = "a".repeat(64);

function publicationFor(publicationId: string) {
  const k = Number.parseInt(publicationId.slice("pub_perf".length), 10);
  const ref = artifactRef(k);
  return {
    ref,
    publishedAt: "2026-10-01T00:00:00.000Z",
    conversationSequence: k + 1,
    kind: ref.kind,
    receipt: {
      receiptId: `rcpt_perf${String(k).padStart(8, "0")}`,
      completedAt: "2026-10-01T00:00:00.000Z",
      profile: null,
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: SHA, byteLength: 512, effectiveSha256: SHA },
    availability: "available",
  };
}

function representationFor(publicationId: string, representation: string) {
  const k = Number.parseInt(publicationId.slice("pub_perf".length), 10);
  const ref = artifactRef(k);
  const data =
    representation === "rendered-svg"
      ? MERMAID_SVG
      : representation === "chart-json" || (ref.kind === "chart" && representation === "source")
        ? chartSpec(seeded(k + 1), k)
        : MERMAID_SOURCES[k % MERMAID_SOURCES.length]!;
  const bytes = new TextEncoder().encode(data).byteLength;
  return {
    artifactId: ref.artifactId,
    revision: ref.revision,
    representation,
    mimeType: representation === "rendered-svg" ? "image/svg+xml" : "text/plain",
    filename: `artifact-${k}`,
    encoding: "utf8",
    data,
    sha256: SHA,
    byteLength: bytes,
    totalBytes: bytes,
    nextOffsetBytes: null,
    executableOutsideOrkestrator: false,
  };
}

function installBackend(): void {
  const capabilities = {
    backendId: BACKEND_ID,
    authoring: false,
    previewRenderer: { available: false, isolation: "unavailable" },
    liveInteractive: false,
    contentOrigin: null,
    rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: false },
  };
  window.orkestrator = {
    ...window.orkestrator,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      counters.backendCalls[command] = (counters.backendCalls[command] ?? 0) + 1;
      let result: unknown;
      switch (command) {
        case "transcript_artifact_capabilities":
          result = capabilities;
          break;
        case "transcript_artifact_get_publication":
          result = publicationFor(String(args?.publicationId));
          break;
        case "transcript_artifact_list_publications":
          result = { publications: [], nextSequence: null };
          break;
        case "transcript_artifact_read_representation":
          result = representationFor(String(args?.publicationId), String(args?.representation));
          break;
        case "transcript_artifact_render_mermaid":
          result = {
            ok: true,
            svg: MERMAID_SVG,
            diagramType: "flowchart",
            rendererVersion: "perf-fixture",
            svgBytes: MERMAID_SVG.length,
            svgElements: 9,
            edges: 2,
            renderDigest: SHA,
          };
          break;
        case "get_file_tree":
        case "get_local_file_tree":
          result = [];
          break;
        default:
          counters.unexpectedCommands++;
          throw new Error("Unexpected perf fixture command");
      }
      return result as T;
    },
  } as NonNullable<Window["orkestrator"]>;
}

function toolDetails(detailRef: string) {
  const n = Number.parseInt(detailRef.slice("perf-image-".length), 10) || 0;
  return { detailRef, fileDataUrl: syntheticImages()[n % 4] };
}

// ---------------------------------------------------------------------------
// Fixture component.

const STREAM_PREAMBLE = "Here is the generated module:\n\n```ts\n";

function ScopeProvider({ children }: { children: ReactNode }): ReactNode {
  if (!identityModule || !capabilitiesModule) return children;
  return <RichScope>{children}</RichScope>;
}

function RichScope({ children }: { children: ReactNode }) {
  const scope = capabilitiesModule!.useRichTranscriptScopeValue(ENVIRONMENT_ID, SESSION_KEY, "1");
  const Provider = identityModule!.RichTranscriptScopeContext.Provider;
  return <Provider value={scope}>{children}</Provider>;
}

interface PerfApi {
  ready: boolean;
  messageCount: () => number;
  counters: () => PerfCounters;
  stats: () => Record<string, unknown>;
  startStream: (intervalMs: number, charsPerTick: number) => void;
  stopStream: () => void;
  clearComposer: () => void;
  remount: () => void;
  scrollToIndex: (index: number) => void;
  scrollToBottom: () => void;
  richIndices: () => number[];
}

declare global {
  interface Window {
    __richPerf?: PerfApi;
  }
}

// The fixture module loads lazily for this route only, so installing the
// fake backend and the mount probe at import time affects no other fixture.
installBackend();
installMountProbe();

export function RichTranscriptPerfFixture() {
  const [generation, setGeneration] = useState(0);
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <ScopeProvider>
        <PerfConversation key={generation} onRemount={() => setGeneration((value) => value + 1)} />
      </ScopeProvider>
    </main>
  );
}

const transcript = buildTranscript();
const transcriptBytes = transcript.reduce((sum, message) => sum + encodedBytes(message), 0);
const richMessageIndices = transcript
  .map((message, index) =>
    message.content.includes("```") || message.parts.length > 1 ? index : -1,
  )
  .filter((index) => index >= 0);

function PerfConversation({ onRemount }: { onRemount: () => void }) {
  const [messages, setMessages] = useState<Message[]>(transcript);
  const [isLoading, setIsLoading] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<MentionableInputRef | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const { scrollProps, virtuosoRef, isAtBottom, scrollToBottom, scrollToIndex } =
    useVirtuosoScrollState();
  const streamRef = useRef<{ timer: number; id: string; code: string; offset: number } | null>(
    null,
  );
  const streamSource = useMemo(() => tsCode(seeded(0x57ea), 999, 2_000), []);

  const stopStream = useCallback(() => {
    if (streamRef.current) window.clearInterval(streamRef.current.timer);
    streamRef.current = null;
    setIsLoading(false);
  }, []);

  const startStream = useCallback(
    (intervalMs: number, charsPerTick: number) => {
      stopStream();
      const id = `perf-stream-${Date.now().toString(36)}`;
      const state = { timer: 0, id, code: "", offset: 0 };
      streamRef.current = state;
      setIsLoading(true);
      setMessages((current) => [
        ...current,
        textMessage(id, "assistant", STREAM_PREAMBLE, MESSAGE_COUNT + current.length),
      ]);
      state.timer = window.setInterval(() => {
        const next = streamSource.slice(state.offset, state.offset + charsPerTick);
        state.offset = (state.offset + charsPerTick) % streamSource.length;
        state.code += next;
        counters.streamTicks++;
        counters.streamChars += next.length;
        const content = `${STREAM_PREAMBLE}${state.code}`;
        setMessages((current) => {
          const last = current.at(-1);
          if (!last || last.id !== id) return current;
          return [
            ...current.slice(0, -1),
            { ...last, content, parts: [{ type: "text", content }] },
          ];
        });
      }, intervalMs);
    },
    [stopStream, streamSource],
  );

  useEffect(() => () => stopStream(), [stopStream]);

  const loadToolDetails = useCallback(
    async (detailRef: string) => toolDetails(detailRef) as never,
    [],
  );

  useEffect(() => {
    window.__richPerf = {
      ready: true,
      messageCount: () => messages.length,
      counters: () => JSON.parse(JSON.stringify(counters)) as PerfCounters,
      stats: () => {
        const result: Record<string, unknown> = {
          liveWorkers: counters.workersCreated - counters.workersTerminated,
          domNodes: document.getElementsByTagName("*").length,
          mountedRows: document.querySelectorAll("[data-item-index]").length,
          mountedRichBlocks: document.querySelectorAll("[data-rich-block]").length,
          transcriptBytes,
          visibilityState: document.visibilityState,
        };
        if (schedulerModule) {
          result.scheduler = schedulerModule.richRenderScheduler.stats();
          result.schedulerCounters = { ...schedulerModule.richRenderScheduler.counters };
        }
        if (artifactRequestsModule) {
          result.artifactRequests = artifactRequestsModule.artifactRequestCacheStats();
        }
        if (viewStoreModule) result.viewStore = viewStoreModule.richViewStoreStats();
        return result;
      },
      startStream,
      stopStream,
      clearComposer: () => setText(""),
      remount: onRemount,
      // The scroll-state hook's own jumps, as the transcript's navigation uses
      // them: a raw Virtuoso jump is re-pinned to the tail by stick intent.
      scrollToIndex: (index: number) => {
        scrollToIndex(index);
      },
      scrollToBottom: () => scrollToBottom(),
      richIndices: () => richMessageIndices,
    };
  }, [messages.length, onRemount, scrollToBottom, scrollToIndex, startStream, stopStream]);

  return (
    <section data-testid="rich-transcript-perf" className="min-h-0 flex-1">
      <NativeChatShell
        agentLabel="Codex"
        platform="codex"
        agentExpansionScope="fixture-rich-transcript-perf"
        isActive
        connectionState="connected"
        displayAvailable
        sessionEstablished
        transcriptSettled
        onRetry={() => {}}
        messages={messages}
        isLoading={isLoading}
        elapsedSeconds={isLoading ? 3 : null}
        finalElapsedSeconds={null}
        loadToolDetails={loadToolDetails}
        centerCompose={false}
        composer={
          <NativeComposeBar
            attachments={[]}
            onRemoveAttachment={() => {}}
            inputRef={inputRef}
            inputContainerRef={inputContainerRef}
            text={text}
            mentions={[]}
            onTextAndMentionsChange={(nextText) => setText(nextText)}
            onCursorPositionChange={() => {}}
            onKeyDown={() => {}}
            placeholder="Send a message"
            isLoading={isLoading}
            primaryControls={null}
            onSend={async () => setText("")}
            onStop={async () => {}}
          />
        }
        isAtBottom={isAtBottom}
        scrollToBottom={scrollToBottom}
        scrollProps={scrollProps}
        virtuosoRef={virtuosoRef}
      />
    </section>
  );
}
