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
import { cachedArtifactSearchBody, clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import {
  artifactBodySearchText,
  artifactPartSearchSegments,
  chartSpecSearchText,
} from "@/lib/chat/rich-search-text";
import { searchRootText } from "@/lib/chat/rich-markdown/find-reveal";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { ArtifactPart } from "./ArtifactPart";

/*
 * Find parity for published artifact bodies: the card's DOM search roots
 * hold exactly the segments the message projection indexes
 * (`artifactPartSearchSegments` with the synchronous body cache), before and
 * after the body loads.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const BACKEND = "backend-1";

function refOf(kind: ArtifactKind): TranscriptArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: `art_${kind
      .replace(/[^a-z]/g, "")
      .slice(0, 8)
      .padEnd(8, "x")}12`,
    revision: 2,
    publicationId: `pub_${kind
      .replace(/[^a-z]/g, "")
      .slice(0, 8)
      .padEnd(8, "x")}12`,
    kind,
    title: "Illustrative artifact",
    summary: "A synthetic summary",
    provenance: { backendId: BACKEND, origin: "agent" },
  };
}

function partOf(ref: TranscriptArtifactRef): NativeArtifactPart {
  return {
    type: "artifact",
    content: artifactPartContent(ref),
    artifact: ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
  };
}

function viewOf(ref: TranscriptArtifactRef): ArtifactPublicationView {
  return {
    ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
    kind: ref.kind,
    receipt: {
      receiptId: "rcpt_abcdefgh1",
      completedAt: "2026-10-20T09:59:00.000Z",
      profile: null,
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: "b".repeat(64) },
    availability: "available",
  };
}

function representation(
  ref: TranscriptArtifactRef,
  kind: ArtifactRepresentationRequest["representation"],
  data: string,
): ArtifactRepresentationResponse {
  return {
    artifactId: ref.artifactId,
    revision: ref.revision,
    representation: kind,
    mimeType: "text/plain",
    filename: "artifact.txt",
    encoding: "utf8",
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
  contentOrigin: null,
  rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
};

type Handler = (command: string, args: Record<string, unknown>) => unknown;
let handler: Handler = () => undefined;

const SCOPE: RichTranscriptScope = {
  backendId: BACKEND,
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g1",
};

function wrap(children: ReactNode) {
  return (
    <RichTranscriptScopeContext.Provider value={SCOPE}>
      <RichMessageContext.Provider value={{ messageId: "m1", role: "assistant" }}>
        {children}
      </RichMessageContext.Provider>
    </RichTranscriptScopeContext.Provider>
  );
}

function domSearchSegments(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-agent-chat-search-content]"),
  ).map(searchRootText);
}

function projection(part: NativeArtifactPart): string[] {
  return artifactPartSearchSegments(part, cachedArtifactSearchBody(part.artifact));
}

const SNAPSHOT: WorkflowSnapshotV1 = {
  schemaVersion: 1,
  workflowId: "wf1",
  runId: "run1",
  sourceRevision: "rev-1",
  capturedAt: "2026-10-20T10:00:00.000Z",
  title: "Nightly review",
  description: "Synthetic snapshot",
  status: "succeeded",
  completeness: {
    mode: "complete",
    totalNodes: 2,
    totalEdges: 1,
    omittedNodes: 0,
    omittedEdges: 0,
  },
  nodes: [
    { id: "n1", label: "Planner agent", role: "agent", status: "succeeded", links: [] },
    { id: "n2", label: "Zebra validator", role: "agent", status: "succeeded", links: [] },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", relation: "handoff", label: "handoff notes" }],
};

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

afterEach(cleanup);

describe("published artifact search beyond the summary", () => {
  test("a chart indexes only its summary until its body loads, then its labels with DOM parity", async () => {
    const ref = refOf("chart");
    const part = partOf(ref);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "chart-json") {
        return gate.then(() =>
          representation(ref, "chart-json", JSON.stringify(REPRESENTATIVE_BAR_CHART)),
        );
      }
      return undefined;
    };
    expect(projection(part)).toEqual(["A synthetic summary"]);
    const { container } = render(wrap(<ArtifactPart part={part} />));
    await waitFor(() => expect(screen.getByText("Loading chart data…")).toBeTruthy());
    expect(projection(part)).toEqual(["A synthetic summary"]);
    expect(domSearchSegments(container)).toEqual(projection(part));

    await act(async () => release());
    await waitFor(() =>
      expect(container.querySelector('svg[data-chart-kind="bar"]')).not.toBeNull(),
    );
    const labels = chartSpecSearchText(REPRESENTATIVE_BAR_CHART);
    expect(labels).toContain("Run B");
    expect(labels).toContain("Integration");
    expect(projection(part)).toEqual(["A synthetic summary", labels]);
    expect(domSearchSegments(container)).toEqual(projection(part));
  });

  test("a workflow snapshot indexes its node and edge labels once loaded", async () => {
    const ref = refOf("workflow-snapshot");
    const part = partOf(ref);
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "workflow-json")
        return representation(ref, "workflow-json", JSON.stringify(SNAPSHOT));
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={part} />));
    await waitFor(() =>
      expect(container.querySelector('[data-rich-block="workflow-snapshot"]')).not.toBeNull(),
    );
    await waitFor(() => expect(projection(part)).toHaveLength(2));
    expect(projection(part)[1]).toContain("Zebra validator");
    expect(projection(part)[1]).toContain("handoff notes");
    expect(domSearchSegments(container)).toEqual(projection(part));
    // Scrolling away keeps the loaded body searchable.
    cleanup();
    expect(projection(part)[1]).toContain("Planner agent");
  });

  test("Mermaid source is searchable only while the source view shows it", async () => {
    const ref = refOf("mermaid");
    const part = partOf(ref);
    const source = "flowchart LR\n  Alpha --> Quokka";
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "rendered-svg")
        return representation(
          ref,
          "rendered-svg",
          '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>',
        );
      if (args.representation === "source") return representation(ref, "source", source);
      return undefined;
    };
    const { container } = render(wrap(<ArtifactPart part={part} />));
    await waitFor(() =>
      expect(
        container.querySelector('[data-artifact-mermaid="true"]') ??
          container.querySelector('[data-artifact-part="mermaid"] [role="note"]'),
      ).not.toBeNull(),
    );
    expect(projection(part)).toEqual(["A synthetic summary"]);
    expect(domSearchSegments(container)).toEqual(projection(part));

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    await waitFor(() =>
      expect(container.querySelector('[data-chart-source-view="true"]')).not.toBeNull(),
    );
    await waitFor(() => expect(projection(part)).toEqual(["A synthetic summary", source]));
    expect(domSearchSegments(container)).toEqual(projection(part));

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    await waitFor(() => expect(projection(part)).toEqual(["A synthetic summary"]));
    expect(domSearchSegments(container)).toEqual(projection(part));
  });

  test("an invalid body contributes nothing, and a stale cache entry never matches another revision", () => {
    expect(artifactBodySearchText("chart", "{not json")).toBeNull();
    expect(artifactBodySearchText("workflow-snapshot", "[]")).toBeNull();
    const ref = refOf("chart");
    const other = { ...ref, revision: 3 };
    expect(artifactPartSearchSegments(partOf(other), cachedArtifactSearchBody(other))).toEqual([
      "A synthetic summary",
    ]);
  });
});
