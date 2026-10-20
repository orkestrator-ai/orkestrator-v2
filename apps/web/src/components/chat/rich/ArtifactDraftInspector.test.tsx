import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactDraftReadRequest,
  type ArtifactDraftSummary,
  type ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { RichTranscriptScopeContext, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import { ToolPart } from "../NativeMessage.basic-parts";
import { draftArtifactIdHint, draftInspectorTool } from "./ArtifactDraftInspector";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const SCOPE: RichTranscriptScope = {
  backendId: "backend-1",
  environmentId: "env-1",
  logicalSessionKey: "env-env-1:tab-1",
  generation: "g1",
};

const SOURCE_PART_1 = "<!doctype html>\n<main>\t<h1>Draft &lt;one&gt;</h1>";
const SOURCE_PART_2 = "\n<p>😀 tail</p>\n";

const FAILED_DRAFT: ArtifactDraftSummary = {
  artifactId: "art_failing01",
  kind: "html-static",
  title: "Broken report",
  summary: "A report whose preview failed",
  currentRevision: 3,
  publishedRevision: 2,
  updatedAt: "2026-10-20T10:00:00.000Z",
  latestOperation: {
    operationId: "op_abcdefgh1",
    revision: 3,
    status: "failed",
    error: {
      code: "validation_failed",
      message: "The document threw during load",
      retryClass: "after-edit",
    },
    diagnostics: [
      {
        severity: "error",
        code: "script_error",
        message: "ReferenceError: chart is not defined",
        location: "12:7",
      },
      { severity: "warning", code: "css_external", message: "External font ignored" },
    ],
    omittedDiagnostics: 2,
    diagnosticCaptureCount: 1,
    semantics: "not-assessed",
  },
};

const OTHER_DRAFT: ArtifactDraftSummary = {
  artifactId: "art_another01",
  kind: "chart",
  title: "Chart draft",
  summary: "",
  currentRevision: 1,
  publishedRevision: null,
  updatedAt: "2026-10-20T10:00:00.000Z",
  latestOperation: null,
};

function slice(
  request: ArtifactDraftReadRequest,
  data: string,
  next: number | null,
  overrides: Partial<ArtifactRepresentationResponse> = {},
): ArtifactRepresentationResponse {
  return {
    artifactId: request.artifactId,
    revision: request.revision ?? 3,
    representation: "source",
    mimeType: "text/html",
    filename: "draft.html",
    encoding: "utf8",
    data,
    sha256: "f".repeat(64),
    byteLength: new TextEncoder().encode(data).byteLength,
    totalBytes: new TextEncoder().encode(SOURCE_PART_1 + SOURCE_PART_2).byteLength,
    nextOffsetBytes: next,
    executableOutsideOrkestrator: true,
    ...overrides,
  };
}

let drafts: ArtifactDraftSummary[] | Error = [FAILED_DRAFT, OTHER_DRAFT];
const reads: ArtifactDraftReadRequest[] = [];

beforeEach(() => {
  drafts = [FAILED_DRAFT, OTHER_DRAFT];
  reads.length = 0;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts) {
      if (drafts instanceof Error) throw drafts;
      return drafts;
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.readDraft) {
      const request = args as unknown as ArtifactDraftReadRequest;
      reads.push(request);
      if (request.representation === "diagnostic-capture") {
        return {
          ...slice(request, "iVBORw0KGgo=", null),
          representation: "capture",
          mimeType: "image/png",
          encoding: "base64",
        };
      }
      const offset = request.sourceRange?.offsetBytes ?? 0;
      if (offset === 0) {
        return slice(request, SOURCE_PART_1, new TextEncoder().encode(SOURCE_PART_1).byteLength);
      }
      return slice(request, SOURCE_PART_2, null);
    }
    return undefined;
  });
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
});

afterEach(cleanup);

function withScope(children: ReactNode, scope: RichTranscriptScope | null = SCOPE) {
  return (
    <RichTranscriptScopeContext.Provider value={scope}>
      {children}
    </RichTranscriptScopeContext.Provider>
  );
}

function renderTool(toolName: string, extra: Partial<Parameters<typeof ToolPart>[0]> = {}) {
  return render(
    withScope(
      <ToolPart
        expansionKey={`tool-${toolName}`}
        toolName={toolName}
        toolState="success"
        toolArgs={{ requestKey: "k", artifactId: "art_failing01", revision: 3 }}
        toolOutput='{"operationId":"op_abcdefgh1","status":"failed"}'
        {...extra}
      />,
    ),
  );
}

describe("draftInspectorTool and hints", () => {
  test("recognises the canonical authoring tools only", () => {
    for (const name of [
      "mcp__orkestrator__create_artifact",
      "orkestrator__update_artifact",
      "orkestrator_preview_artifact",
      "get_artifact_operation",
    ]) {
      expect(draftInspectorTool(name, {})).not.toBeNull();
    }
    expect(draftInspectorTool("mcp__orkestrator__publish_artifact", {})).toBeNull();
    expect(draftInspectorTool("mcp__other__create_artifact", {})).toBeNull();
    expect(draftInspectorTool("create_artifact", { mcpServerName: "other" })).toBeNull();
    expect(draftInspectorTool("Read", {})).toBeNull();
  });

  test("preselects from arguments, then from the tool output", () => {
    expect(draftArtifactIdHint({ artifactId: "art_failing01" }, undefined)).toBe("art_failing01");
    expect(draftArtifactIdHint({}, '{"artifactId":"art_created01","revision":1}')).toBe(
      "art_created01",
    );
    expect(draftArtifactIdHint({ artifactId: "../etc" }, "no id")).toBeNull();
  });
});

describe("Inspect draft action", () => {
  test("canonical artifact rows get the action beside, not inside, the row trigger", () => {
    const { container } = renderTool("mcp__orkestrator__preview_artifact");
    const action = screen.getByRole("button", { name: "Inspect draft" });
    expect(action.parentElement?.closest("button") === null).toBe(true);
    expect(container.querySelectorAll("button button")).toHaveLength(0);
    cleanup();
    renderTool("Read");
    expect(screen.queryByRole("button", { name: "Inspect draft" }) === null).toBe(true);
    cleanup();
    renderTool("mcp__orkestrator__create_artifact", { mcpServerName: "other-server" });
    expect(screen.queryByRole("button", { name: "Inspect draft" }) === null).toBe(true);
    cleanup();
    // Outside a conversation scope there is nothing to inspect.
    render(withScope(<ToolPart expansionKey="x" toolName="create_artifact" />, null));
    expect(screen.queryByRole("button", { name: "Inspect draft" }) === null).toBe(true);
  });

  test("shows the exact draft source, diagnostics and failed-preview captures, labelled as a draft", async () => {
    renderTool("mcp__orkestrator__get_artifact_operation");
    fireEvent.click(screen.getByRole("button", { name: "Inspect draft" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      invokeMock.mock.calls.find((call) => call[0] === TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts)![1],
    ).toEqual({ environmentId: "env-1", logicalSessionKey: "env-env-1:tab-1" });

    await waitFor(() =>
      expect(dialog.querySelector('[data-artifact-draft-label="true"]')?.textContent).toBe(
        "Draft — not published (revision 3)",
      ),
    );
    expect(within(dialog).getByText("Revision 2 is the published one.")).toBeTruthy();
    // Latest operation: status in words, error code, diagnostic codes and locations.
    expect(within(dialog).getByText(/Latest verification: Failed/)).toBeTruthy();
    expect(dialog.querySelector('[data-artifact-draft-error="validation_failed"]')).not.toBeNull();
    const rows = Array.from(dialog.querySelectorAll("[data-artifact-diagnostic]"));
    expect(rows.map((row) => row.getAttribute("data-artifact-diagnostic"))).toEqual([
      "script_error",
      "css_external",
    ]);
    expect(rows[0]!.textContent).toContain("12:7");
    expect(within(dialog).getByText(/2 more diagnostics were omitted/)).toBeTruthy();

    // The first bounded slice of the exact revision.
    await waitFor(() =>
      expect(dialog.querySelector('[data-artifact-draft-source="true"]')?.textContent).toBe(
        SOURCE_PART_1,
      ),
    );
    const first = reads.find((read) => read.representation === "source")!;
    expect(first).toMatchObject({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab-1",
      artifactId: "art_failing01",
      revision: 3,
      sourceRange: { offsetBytes: 0 },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(dialog.querySelector('[data-artifact-draft-source="true"]')?.textContent).toBe(
        SOURCE_PART_1 + SOURCE_PART_2,
      ),
    );

    // Failed-preview capture as an image, read by operation and index.
    await waitFor(() =>
      expect(dialog.querySelector('img[data-artifact-draft-capture="0"]')).not.toBeNull(),
    );
    expect(dialog.querySelector('img[data-artifact-draft-capture="0"]')!.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(reads.find((read) => read.representation === "diagnostic-capture")).toMatchObject({
      artifactId: "art_failing01",
      revision: 3,
      operationId: "op_abcdefgh1",
      captureIndex: 0,
    });

    // Copy source copies the whole exact source across slices, byte for byte.
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy source" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    expect(mockWriteText.mock.calls[0]).toEqual([SOURCE_PART_1 + SOURCE_PART_2] as never);

    // Another draft can be selected; an unverified one says so.
    fireEvent.click(within(dialog).getByRole("button", { name: /Chart draft/ }));
    await waitFor(() =>
      expect(dialog.querySelector('[data-artifact-draft-operation="none"]')).not.toBeNull(),
    );
    expect(dialog.querySelector('[data-artifact-draft-label="true"]')?.textContent).toBe(
      "Draft — not published (revision 1)",
    );
  });

  test("a source that changes between slices is not copied", async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts) return [FAILED_DRAFT];
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.readDraft) {
        const request = args as unknown as ArtifactDraftReadRequest;
        if (request.representation === "diagnostic-capture") throw new Error("gone");
        const offset = request.sourceRange?.offsetBytes ?? 0;
        return offset === 0
          ? slice(request, SOURCE_PART_1, 10)
          : slice(request, SOURCE_PART_2, null, { sha256: "0".repeat(64) });
      }
      return undefined;
    });
    renderTool("mcp__orkestrator__update_artifact");
    fireEvent.click(screen.getByRole("button", { name: "Inspect draft" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelector('[data-artifact-draft-source="true"]')).not.toBeNull(),
    );
    await waitFor(() => expect(within(dialog).getByText(/Capture 1 is unavailable/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy source" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  test("a failed draft list shows the backend's message with a retry", async () => {
    drafts = new Error(JSON.stringify({ code: "storage_corrupt", message: "Draft store damaged" }));
    renderTool("mcp__orkestrator__create_artifact");
    fireEvent.click(screen.getByRole("button", { name: "Inspect draft" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain("Draft store damaged"),
    );
    drafts = [OTHER_DRAFT];
    fireEvent.click(within(dialog).getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(within(dialog).getAllByText("Chart draft").length).toBeGreaterThan(0),
    );
  });
});
