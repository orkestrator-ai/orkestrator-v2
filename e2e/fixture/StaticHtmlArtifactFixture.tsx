/**
 * The real artifact card over a fake backend (`/static-html-artifact`), for
 * the static HTML presentation specs. All content is synthetic.
 *
 * Query: `doc` (report, tall, hostile, plain, oversized, elements), `count` (cards),
 * `interactive=1` (adds an interactive card), `tamper=1` (a stored document
 * that does not match its receipt), `presentation=off` (the rollback control),
 * `theme=light`. The application itself ships dark only, so the light theme here
 * sets the root tokens a light theme would.
 */
import { useState } from "react";
import { sha256Hex } from "@orkestrator/protocol/graphs/sha256";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  ACTIVITY_REPORT_HTML,
  HOSTILE_REPORT_HTML,
  PLAIN_REPORT_HTML,
  TALL_REPORT_HTML,
} from "@orkestrator/protocol/testing/static-html-fixtures";
import { artifactPartContent } from "@orkestrator/protocol/transcript-artifacts";
import { ArtifactPart } from "../../apps/web/src/components/chat/rich/ArtifactPart";
import type { NativeArtifactPart } from "../../apps/web/src/lib/chat/native-message-types";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
} from "../../apps/web/src/lib/chat/rich-identity";
import { staticFrameSlotStats } from "../../apps/web/src/stores/staticHtmlFrameSlots";

const BACKEND = "static-fixture-backend";
const query = new URLSearchParams(window.location.search);

const DOCUMENTS: Record<string, string> = {
  report: ACTIVITY_REPORT_HTML,
  tall: TALL_REPORT_HTML,
  hostile: HOSTILE_REPORT_HTML,
  plain: PLAIN_REPORT_HTML,
  oversized: `<!doctype html><p>${"x".repeat(STATIC_PRESENTATION_POLICY.maxDocumentBytes + 1)}</p>`,
  elements: `<!doctype html><div>${"<i></i>".repeat(STATIC_PRESENTATION_POLICY.maxElements + 1)}</div>`,
};

const TITLES: Record<string, string> = {
  report: "Agent activity and cost",
  tall: "Long report",
  hostile: "Hostile report",
  plain: "Plain report",
  oversized: "Oversized report",
  elements: "Report with too many elements",
};

const docName = query.get("doc") ?? "report";
const html = DOCUMENTS[docName] ?? ACTIVITY_REPORT_HTML;
const tampered = query.get("tamper") === "1";
const stored = tampered ? html.replace("Agent activity", "Altered activity") : html;
const count = Math.max(1, Number.parseInt(query.get("count") ?? "1", 10) || 1);
const interactive = query.get("interactive") === "1";

function savedPreview(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 640;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f4f4f5";
  context.fillRect(0, 0, 960, 640);
  context.fillStyle = "#3f3f46";
  context.font = "28px sans-serif";
  context.fillText("Saved preview (static image)", 48, 80);
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

function refOf(index: number) {
  const suffix = String(index).padStart(8, "0");
  const isInteractive = interactive && index === count;
  return {
    schemaVersion: 1 as const,
    artifactId: `art_static${suffix}`,
    revision: 1,
    publicationId: `pub_static${suffix}`,
    kind: isInteractive ? ("html-interactive" as const) : ("html-static" as const),
    title: isInteractive
      ? "Interactive card"
      : `${TITLES[docName] ?? "Report"}${count > 1 ? ` ${index + 1}` : ""}`,
    summary: "Synthetic data for acceptance testing.",
    provenance: { backendId: BACKEND, origin: "agent" as const },
  };
}

const calls: Record<string, number> = {};
const opened: string[] = [];
const totalCards = count + (interactive ? 1 : 0);

function installBackend(): void {
  const preview = savedPreview();
  const capabilities = {
    backendId: BACKEND,
    authoring: false,
    // No preview worker and no live host: published documents must still replay.
    previewRenderer: { available: false, isolation: "unavailable", reason: "Not installed" },
    liveInteractive: false,
    contentOrigin: null,
    rolloutFlags: {
      richMarkdown: true,
      artifactPublication: true,
      liveInteractive: false,
      ...(query.get("presentation") === "off" ? { staticPresentation: false } : {}),
    },
  };
  const indexOf = (publicationId: unknown) =>
    Number.parseInt(String(publicationId).slice("pub_static".length), 10);
  window.orkestrator = {
    ...window.orkestrator,
    listen: () => () => {},
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
      },
    },
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls[command] = (calls[command] ?? 0) + 1;
      let result: unknown;
      switch (command) {
        case "transcript_artifact_capabilities":
          result = capabilities;
          break;
        case "transcript_artifact_list_publications":
          result = { publications: [], nextSequence: null };
          break;
        case "transcript_artifact_get_publication": {
          const ref = refOf(indexOf(args?.publicationId));
          result = {
            ref,
            publishedAt: "2026-11-04T00:00:00.000Z",
            conversationSequence: 1,
            kind: ref.kind,
            receipt: {
              receiptId: "rcpt_static00000000",
              completedAt: "2026-11-04T00:00:00.000Z",
              profile: {
                theme: "light",
                viewport: { width: 960, height: 640, deviceScaleFactor: 1 },
              },
              captures: [
                {
                  assetId: "asset_static",
                  sha256: "c".repeat(64),
                  width: 960,
                  height: 640,
                  byteLength: 10,
                },
              ],
              semantics: "not-assessed",
            },
            source: {
              sha256: sha256Hex(html),
              byteLength: html.length,
              effectiveSha256: sha256Hex(html),
            },
            availability: "available",
          };
          break;
        }
        case "transcript_artifact_read_representation": {
          const ref = refOf(indexOf(args?.publicationId));
          if (args?.representation === "capture") {
            result = {
              artifactId: ref.artifactId,
              revision: ref.revision,
              representation: "capture",
              mimeType: "image/png",
              filename: "capture.png",
              encoding: "base64",
              data: preview,
              sha256: "c".repeat(64),
              byteLength: preview.length,
              totalBytes: preview.length,
              nextOffsetBytes: null,
              executableOutsideOrkestrator: false,
            };
            break;
          }
          const bytes = new TextEncoder().encode(stored);
          const range = args?.sourceRange as
            { offsetBytes: number; limitBytes: number } | undefined;
          const offset = range?.offsetBytes ?? 0;
          const end = Math.min(bytes.length, offset + (range?.limitBytes ?? bytes.length));
          result = {
            artifactId: ref.artifactId,
            revision: ref.revision,
            representation: args?.representation,
            mimeType: "text/html; charset=utf-8",
            filename: "report.html",
            encoding: "utf8",
            data: new TextDecoder().decode(bytes.subarray(offset, end)),
            sha256: sha256Hex(stored),
            byteLength: end - offset,
            totalBytes: bytes.length,
            nextOffsetBytes: end < bytes.length ? end : null,
            executableOutsideOrkestrator: true,
          };
          break;
        }
        default:
          throw new Error(`Unexpected fixture command ${command}`);
      }
      return result as T;
    },
  } as unknown as NonNullable<Window["orkestrator"]>;
  (window as unknown as { __staticFixture: unknown }).__staticFixture = {
    calls: () => ({ ...calls }),
    opened: () => [...opened],
    stats: staticFrameSlotStats,
  };
}

const scope = {
  backendId: BACKEND,
  environmentId: "static-fixture-env",
  logicalSessionKey: "static-fixture-env:session",
  generation: "g1",
};

function applyAppearance(appearance: "light" | "dark"): void {
  const root = document.documentElement;
  const light: Record<string, string> = {
    "--color-background": "#ffffff",
    "--color-foreground": "#18181b",
    "--color-card": "#ffffff",
    "--color-card-foreground": "#18181b",
    "--color-muted": "#f4f4f5",
    "--color-muted-foreground": "#52525b",
    "--color-border": "#d4d4d8",
    "--color-primary": "#2563eb",
  };
  for (const [name, value] of Object.entries(light)) {
    if (appearance === "light") root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.style.colorScheme = appearance;
  root.classList.toggle("dark", appearance === "dark");
}

export function StaticHtmlArtifactFixture() {
  const [ready] = useState(() => {
    installBackend();
    if (query.get("theme") === "light") applyAppearance("light");
    return true;
  });
  if (!ready) return null;
  return (
    <main
      className="h-screen overflow-auto bg-background p-4 text-foreground"
      data-testid="scroller"
    >
      <button
        type="button"
        className="mb-3 rounded border border-border px-2 py-1 text-xs"
        onClick={() =>
          applyAppearance(document.documentElement.classList.contains("dark") ? "light" : "dark")
        }
      >
        Toggle theme
      </button>
      <RichTranscriptScopeContext.Provider value={scope}>
        {Array.from({ length: totalCards }, (_, index) => {
          const ref = refOf(index);
          const part = {
            type: "artifact",
            content: artifactPartContent(ref),
            artifact: ref,
            publishedAt: "2026-11-04T00:00:00.000Z",
            conversationSequence: index + 1,
          } as NativeArtifactPart;
          return (
            <RichMessageContext.Provider
              key={ref.publicationId}
              value={{ messageId: `message-${index}`, role: "assistant" }}
            >
              <div className="mb-3 max-w-[900px]">
                <ArtifactPart part={part} />
              </div>
            </RichMessageContext.Provider>
          );
        })}
      </RichTranscriptScopeContext.Provider>
    </main>
  );
}
