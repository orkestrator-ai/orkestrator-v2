import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { REPRESENTATIVE_BAR_CHART } from "@orkestrator/protocol/testing/rich-content-fixtures";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
  type ArtifactRepresentationRequest,
  type ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  artifactPartContent,
  type ArtifactKind,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";
import { invoke } from "@/lib/native/backend";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { ArtifactPart } from "./ArtifactPart";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const BACKEND = "backend-1";

function refOf(
  kind: ArtifactKind,
  overrides: Partial<TranscriptArtifactRef> = {},
): TranscriptArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: "art_abcdefgh1",
    revision: 2,
    publicationId: "pub_abcdefgh1",
    kind,
    title: "Illustrative artifact",
    summary: "A synthetic summary",
    provenance: { backendId: BACKEND, origin: "agent" },
    ...overrides,
  };
}

function partOf(artifact: unknown): NativeArtifactPart {
  const ref = artifact as TranscriptArtifactRef;
  return {
    type: "artifact",
    content: ref && typeof ref === "object" && ref.title ? artifactPartContent(ref) : "[Artifact]",
    artifact: ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
  };
}

function viewOf(
  ref: TranscriptArtifactRef,
  overrides: Partial<ArtifactPublicationView> = {},
): ArtifactPublicationView {
  const html = ref.kind === "html-static" || ref.kind === "html-interactive";
  return {
    ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
    kind: ref.kind,
    receipt: {
      receiptId: "rcpt_abcdefgh1",
      completedAt: "2026-10-20T09:59:00.000Z",
      profile: html
        ? { theme: "light", viewport: { width: 960, height: 640, deviceScaleFactor: 1 } }
        : null,
      captures: html
        ? [
            {
              assetId: "asset_abcdefgh1",
              sha256: "c".repeat(64),
              width: 960,
              height: 640,
              byteLength: 10,
            },
          ]
        : [],
      ...(ref.kind === "html-interactive" ? { probeSummary: { total: 3, passed: 3 } } : {}),
      semantics: ref.kind === "html-interactive" ? "probes-passed" : "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: "b".repeat(64) },
    availability: "available",
    ...overrides,
  };
}

function representation(
  ref: TranscriptArtifactRef,
  kind: ArtifactRepresentationRequest["representation"],
  data: string,
  encoding: "utf8" | "base64" = "utf8",
  mimeType = "text/plain",
): ArtifactRepresentationResponse {
  return {
    artifactId: ref.artifactId,
    revision: ref.revision,
    representation: kind,
    mimeType,
    filename: "artifact.txt",
    encoding,
    data,
    sha256: "d".repeat(64),
    byteLength: data.length,
    totalBytes: data.length,
    nextOffsetBytes: null,
    executableOutsideOrkestrator: false,
  };
}

const capabilities = {
  backendId: BACKEND,
  authoring: true,
  previewRenderer: { available: true, isolation: "container" },
  liveInteractive: true,
  contentOrigin: "http://127.0.0.1:9999",
  rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
};

type Handler = (command: string, args: Record<string, unknown>) => unknown;
let handler: Handler = () => undefined;

function scope(generation = "g1"): RichTranscriptScope {
  return { backendId: BACKEND, environmentId: "env-1", logicalSessionKey: "session-1", generation };
}

function wrap(children: ReactNode, generation = "g1") {
  return (
    <RichTranscriptScopeContext.Provider value={scope(generation)}>
      <RichMessageContext.Provider value={{ messageId: "m1", role: "assistant" }}>
        {children}
      </RichMessageContext.Provider>
    </RichTranscriptScopeContext.Provider>
  );
}

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  useRichContentViewStore.getState().reset();
  useArtifactLiveHostStore.getState().resetForTests();
  invokeMock.mockReset();
  handler = () => undefined;
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) return Promise.resolve(capabilities);
    return Promise.resolve(handler(command, args ?? {}));
  });
});

afterEach(() => {
  cleanup();
});

describe("ArtifactPart — honest placeholders", () => {
  test("an unknown kind renders its title, summary and an unsupported message without fetching", async () => {
    const artifact = { ...refOf("chart"), kind: "spreadsheet" };
    render(wrap(<ArtifactPart part={partOf(artifact)} />));
    expect(screen.getByText("Illustrative artifact")).toBeTruthy();
    expect(screen.getByText("A synthetic summary")).toBeTruthy();
    expect(screen.getByText(/not supported by this client/)).toBeTruthy();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication)).toHaveLength(0);
  });

  test("a newer schema version is unsupported, not a crash", () => {
    render(wrap(<ArtifactPart part={partOf({ ...refOf("chart"), schemaVersion: 2 })} />));
    expect(screen.getByText(/newer format/)).toBeTruthy();
  });

  test("a malformed reference shows only its textual summary", () => {
    const part = { ...partOf(null), content: "[Artifact: Broken]" };
    const { container } = render(wrap(<ArtifactPart part={part} />));
    expect(container.querySelector('[data-artifact-notice="invalid"]')?.textContent).toContain(
      "[Artifact: Broken]",
    );
    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  test("a reference from another backend is not treated as authoritative", async () => {
    const ref = refOf("chart", { provenance: { backendId: "other-backend", origin: "agent" } });
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-notice="foreign-backend"]')).not.toBeNull(),
    );
    expect(screen.getByText(/different Orkestrator backend/)).toBeTruthy();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication)).toHaveLength(0);
  });

  test("storage problems become an artifact-level unavailable state that keeps the summary", async () => {
    const ref = refOf("chart");
    handler = (command) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication
        ? viewOf(ref, { availability: "storage_corrupt" })
        : undefined;
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-notice="unavailable"]')).not.toBeNull(),
    );
    expect(screen.getByText("A synthetic summary")).toBeTruthy();
    expect(screen.getByText(/failed its integrity check/)).toBeTruthy();
  });

  test("a not-found publication is reported as unavailable in this conversation", async () => {
    const ref = refOf("chart");
    handler = (command) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication)
        throw Object.assign(new Error("missing"), { code: "not_found" });
      return undefined;
    };
    render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(screen.getByText(/not available in this conversation/)).toBeTruthy(),
    );
  });

  test("a response naming another revision is not shown", async () => {
    const ref = refOf("chart");
    handler = (command) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication
        ? viewOf({ ...ref, revision: 3 })
        : undefined;
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-notice="mismatch"]')).not.toBeNull(),
    );
  });
});

describe("ArtifactPart — published kinds", () => {
  test("a chart resolves through the conversation scope and renders natively", async () => {
    const ref = refOf("chart");
    const source = JSON.stringify(REPRESENTATIVE_BAR_CHART);
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (
        command === TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation &&
        args.representation === "chart-json"
      ) {
        return representation(ref, "chart-json", source, "utf8", "application/json");
      }
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('svg[data-chart-kind="bar"]')).not.toBeNull(),
    );
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication)[0]).toEqual({
      environmentId: "env-1",
      logicalSessionKey: "session-1",
      publicationId: "pub_abcdefgh1",
    });
    expect(container.querySelector('[data-chart-provenance="published"]')?.textContent).toContain(
      "revision 2",
    );
    expect(screen.getByText("Validated by the native chart renderer")).toBeTruthy();
    expect(screen.getByText("Revision 2")).toBeTruthy();
  });

  test("late responses from a discarded scope generation never populate the card", async () => {
    const ref = refOf("chart");
    const pending = new Map<string, (value: unknown) => void>();
    handler = () => undefined;
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities)
        return Promise.resolve(capabilities);
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) {
        return new Promise((resolve) => pending.set(`call-${pending.size + 1}`, resolve));
      }
      if (
        command === TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation &&
        args.representation === "chart-json"
      ) {
        return Promise.resolve(
          representation(ref, "chart-json", JSON.stringify(REPRESENTATIVE_BAR_CHART)),
        );
      }
      return Promise.resolve(undefined);
    });
    const { container, rerender } = render(wrap(<ArtifactPart part={partOf(ref)} />, "g1"));
    await waitFor(() => expect(pending.size).toBe(1));
    rerender(wrap(<ArtifactPart part={partOf(ref)} />, "g2"));
    await waitFor(() => expect(pending.size).toBe(2));
    // The discarded generation answers late with a different (corrupt) state.
    await act(async () => pending.get("call-1")!(viewOf(ref, { availability: "storage_corrupt" })));
    expect(container.querySelector('[data-artifact-notice="unavailable"]') === null).toBe(true);
    await act(async () => pending.get("call-2")!(viewOf(ref)));
    await waitFor(() =>
      expect(container.querySelector('svg[data-chart-kind="bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-artifact-notice="unavailable"]') === null).toBe(true);
  });

  test("a workflow snapshot renders as a historical Snapshot card", async () => {
    const ref = refOf("workflow-snapshot");
    const snapshot: WorkflowSnapshotV1 = {
      schemaVersion: 1,
      workflowId: "wf1",
      runId: "run1",
      sourceRevision: "rev-1",
      capturedAt: "2026-10-20T10:00:00.000Z",
      title: "Run",
      description: "",
      status: "succeeded",
      completeness: {
        mode: "complete",
        totalNodes: 1,
        totalEdges: 0,
        omittedNodes: 0,
        omittedEdges: 0,
      },
      nodes: [{ id: "n1", label: "Agent", role: "agent", status: "succeeded", links: [] }],
      edges: [],
    };
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "workflow-json")
        return representation(ref, "workflow-json", JSON.stringify(snapshot));
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-rich-block="workflow-snapshot"]')).not.toBeNull(),
    );
    expect(screen.getByText("Captured from the workflow service")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open live workflow/ })).toBeTruthy();
  });

  test("a mermaid diagram is sanitized again and never inserts active content", async () => {
    const ref = refOf("mermaid");
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "rendered-svg") {
        return representation(
          ref,
          "rendered-svg",
          '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="https://example.com"><text>A</text></a><rect width="5" height="5"/></svg>',
          "utf8",
          "image/svg+xml",
        );
      }
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(
        container.querySelector('[data-artifact-mermaid="true"]') ??
          container.querySelector('[data-artifact-part="mermaid"] [role="note"]'),
      ).not.toBeNull(),
    );
    expect(container.querySelectorAll("script, a, foreignObject")).toHaveLength(0);
    expect(
      Array.from(container.querySelectorAll("*")).some((element) => element.hasAttribute("onload")),
    ).toBe(false);
    expect(screen.getByText("Rendered under the strict diagram policy")).toBeTruthy();
  });

  test("static HTML shows its saved capture, receipt profile and honest export labels", async () => {
    const ref = refOf("html-static");
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "capture")
        return representation(ref, "capture", "iVBORw0KGgo=", "base64", "image/png");
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    expect(container.querySelector("iframe") === null).toBe(true);
    expect(screen.getByText("Verified at light 960×640")).toBeTruthy();
    expect(screen.getByText(/Semantics not assessed/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Download HTML source — runs outside Orkestrator's isolation",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download PNG" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print saved preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run interactive" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(container.querySelector('[data-artifact-diagnostics="true"]')?.textContent).toContain(
      "rcpt_abcdefgh1",
    );
  });

  test("interactive HTML shows the saved preview and starts only on an explicit Run interactive", async () => {
    const ref = refOf("html-interactive");
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "capture")
        return representation(ref, "capture", "iVBORw0KGgo=", "base64", "image/png");
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession) {
        return {
          contentUrl: "http://127.0.0.1:9999/artifact/doc?cap=x",
          shellUrl: "http://127.0.0.1:9999/shell/doc?cap=x",
          expiresAt: "2026-10-20T11:00:00.000Z",
          preparedSha256: "e".repeat(64),
          artifactId: ref.artifactId,
          revision: ref.revision,
          generation: "live-gen-1",
          readinessNonce: "nonce-12345678",
        };
      }
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={partOf(ref)} />));
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    expect(screen.getByText(/Interactions verified by 3 probes/)).toBeTruthy();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Run interactive" }));
    await waitFor(() => expect(useArtifactLiveHostStore.getState().active?.phase).toBe("loading"));
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)[0]).toEqual({
      environmentId: "env-1",
      logicalSessionKey: "session-1",
      publicationId: "pub_abcdefgh1",
    });
    expect(container.querySelector('[data-artifact-live-placeholder="inline"]')).not.toBeNull();
    // The document never runs inside the transcript row itself.
    expect(container.querySelector("iframe") === null).toBe(true);

    // A scope invalidation disposes the view; the card shows the saved preview with the reason.
    act(() =>
      useArtifactLiveHostStore.getState().invalidate("The conversation's environment was deleted."),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-live-ended="true"]')?.textContent).toContain(
        "Interactive view closed: The conversation's environment was deleted.",
      ),
    );
    expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull();
    expect(container.querySelector("[data-artifact-live-placeholder]") === null).toBe(true);
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toEqual([
      { generation: "live-gen-1" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container.querySelector('[data-artifact-live-ended="true"]') === null).toBe(true);
  });
});
