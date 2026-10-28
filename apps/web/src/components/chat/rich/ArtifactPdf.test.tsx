import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
  type TranscriptArtifactCapabilities,
  type TranscriptMediaPdfPreviewResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  artifactPartContent,
  type ArtifactKind,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { invoke } from "@/lib/native/backend";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import { defaultPrintPaper } from "@/lib/chat/artifact-download";
import { clearImagePreviewCache } from "@/lib/chat/image-preview-cache";
import { clearMediaResolverInflight } from "@/lib/chat/rich-markdown/media-resolver";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { AgentPlatformContext } from "../NativeMessage.shared";
import { ArtifactPart } from "./ArtifactPart";
import { FilePreview } from "./FilePreview";
import { pdfPreviewSource } from "./PdfFirstPagePreview";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const BACKEND = "backend-1";
const PDF_BASE64 = btoa("%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF");

function refOf(kind: ArtifactKind): TranscriptArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: "art_pdfcard01",
    revision: 3,
    publicationId: "pub_pdfcard01",
    kind,
    title: "Quarterly: report/v2",
    summary: "A synthetic summary",
    provenance: { backendId: BACKEND, origin: "agent" },
  };
}

function viewOf(ref: TranscriptArtifactRef): ArtifactPublicationView {
  return {
    ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
    kind: ref.kind,
    receipt: {
      receiptId: "rcpt_pdfcard01",
      completedAt: "2026-10-20T09:59:00.000Z",
      profile: { theme: "light", viewport: { width: 960, height: 640, deviceScaleFactor: 1 } },
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: "b".repeat(64) },
    availability: "available",
  };
}

function capabilitiesWith(
  overrides: Partial<TranscriptArtifactCapabilities> = {},
): TranscriptArtifactCapabilities {
  return {
    backendId: BACKEND,
    authoring: true,
    previewRenderer: { available: true, isolation: "container", interactiveIsolation: "container" },
    liveInteractive: true,
    contentOrigin: "http://127.0.0.1:9999",
    rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
    ...overrides,
  };
}

type Handler = (command: string, args: Record<string, unknown>) => unknown;
let handler: Handler = () => undefined;
let capabilities = capabilitiesWith();

const SCOPE: RichTranscriptScope = {
  backendId: BACKEND,
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g1",
};

function wrap(children: ReactNode) {
  return (
    <RichTranscriptScopeContext.Provider value={SCOPE}>
      <AgentPlatformContext.Provider value="claude">
        <RichMessageContext.Provider value={{ messageId: "m1", role: "assistant" }}>
          {children}
        </RichMessageContext.Provider>
      </AgentPlatformContext.Provider>
    </RichTranscriptScopeContext.Provider>
  );
}

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:test";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
});

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  clearImagePreviewCache();
  clearMediaResolverInflight();
  useRichContentViewStore.getState().reset();
  useArtifactLiveHostStore.getState().resetForTests();
  invokeMock.mockReset();
  handler = () => undefined;
  capabilities = capabilitiesWith();
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) return Promise.resolve(capabilities);
    return Promise.resolve(handler(command, args ?? {}));
  });
});

afterEach(() => {
  cleanup();
});

describe("artifact PDF representation", () => {
  test("Download PDF asks for the exact revision's pdf representation and saves an attachment", async () => {
    const ref = refOf("html-static");
    handler = (command, args) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (args.representation === "pdf")
        return {
          artifactId: ref.artifactId,
          revision: ref.revision,
          representation: "pdf",
          mimeType: "application/pdf",
          filename: "server-name.pdf",
          encoding: "base64",
          data: PDF_BASE64,
          sha256: "e".repeat(64),
          byteLength: 40,
          totalBytes: 40,
          nextOffsetBytes: null,
          executableOutsideOrkestrator: false,
          print: {
            profileVersion: "artifact-print-profile:v1",
            profileHash: "f".repeat(64),
            paper: args.paper,
            pageCount: 2,
            receiptId: "rcpt_pdfcard01",
          },
        };
      return undefined;
    };
    const clicks: Array<{ download: string; href: string }> = [];
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
    try {
      render(
        wrap(
          <ArtifactPart
            part={{
              type: "artifact",
              content: artifactPartContent(ref),
              artifact: ref,
              publishedAt: "2026-10-20T10:00:00.000Z",
              conversationSequence: 1,
            }}
          />,
        ),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Download PDF" }));
      await waitFor(() => expect(clicks).toHaveLength(1));
      expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation).at(-1)).toEqual({
        environmentId: "env-1",
        logicalSessionKey: "session-1",
        publicationId: "pub_pdfcard01",
        representation: "pdf",
        paper: defaultPrintPaper(),
      });
      // Filename derived from the title on the client, never a path.
      expect(clicks[0]!.download).toBe("Quarterly report v2.pdf");
      // The saved preview stays the print fallback.
      expect(screen.getByRole("button", { name: "Print saved preview" })).toBeTruthy();
    } finally {
      click.mockRestore();
    }
  });

  test("paper follows the reader's region and only ever names the two fixed sizes", () => {
    expect(defaultPrintPaper("en-US")).toBe("letter");
    expect(defaultPrintPaper("fr-CA")).toBe("letter");
    expect(defaultPrintPaper("en-GB")).toBe("a4");
    expect(defaultPrintPaper("de")).toBe("a4");
    expect(defaultPrintPaper("")).toBe("a4");
  });
});

describe("prepare isolated preview worker", () => {
  test("offered when interactive isolation is unavailable and the backend can prepare it", async () => {
    capabilities = capabilitiesWith({
      previewRenderer: {
        available: true,
        isolation: "process",
        interactiveIsolation: "unavailable",
        interactiveReason: "interactive previews need the container worker",
      },
      workerPreparation: { available: true, state: "idle", method: null },
    });
    const ref = refOf("html-interactive");
    handler = (command) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) return viewOf(ref);
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.prepareWorker) {
        capabilities = capabilitiesWith({
          workerPreparation: { available: true, state: "ready", method: "build" },
        });
        return {
          available: true,
          state: "ready",
          method: "build",
          image: `sha256:${"1".repeat(64)}`,
          isolation: "container",
          interactiveIsolation: "container",
        };
      }
      return undefined;
    };
    render(
      wrap(
        <ArtifactPart
          part={{
            type: "artifact",
            content: artifactPartContent(ref),
            artifact: ref,
            publishedAt: "2026-10-20T10:00:00.000Z",
            conversationSequence: 1,
          }}
        />,
      ),
    );
    const button = await screen.findByRole("button", { name: "Prepare isolated preview worker" });
    fireEvent.click(button);
    expect(
      await screen.findByText(/interactive previews now run in container isolation/),
    ).toBeTruthy();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.prepareWorker)).toHaveLength(1);
    // Capabilities were read again after preparation.
    await waitFor(() =>
      expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities).length).toBeGreaterThanOrEqual(2),
    );
  });

  test("an outdated worker from before an upgrade is offered for preparation again", async () => {
    capabilities = capabilitiesWith({
      previewRenderer: {
        available: true,
        isolation: "process",
        interactiveIsolation: "unavailable",
        interactiveReason: "interactive previews need the container worker",
      },
      workerPreparation: { available: true, state: "idle", method: null, outdated: true },
    });
    const ref = refOf("html-interactive");
    handler = (command) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication ? viewOf(ref) : undefined;
    render(
      wrap(
        <ArtifactPart
          part={{
            type: "artifact",
            content: artifactPartContent(ref),
            artifact: ref,
            publishedAt: "2026-10-20T10:00:00.000Z",
            conversationSequence: 1,
          }}
        />,
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Prepare isolated preview worker" }),
    ).toBeTruthy();
    expect(screen.getByText(/prepared by an earlier version of Orkestrator/)).toBeTruthy();
    expect(screen.queryByText(/which is not installed on this host/) === null).toBe(true);
  });

  test("not offered when interactive previews already have isolation", async () => {
    const ref = refOf("html-interactive");
    handler = (command) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication ? viewOf(ref) : undefined;
    render(
      wrap(
        <ArtifactPart
          part={{
            type: "artifact",
            content: artifactPartContent(ref),
            artifact: ref,
            publishedAt: "2026-10-20T10:00:00.000Z",
            conversationSequence: 1,
          }}
        />,
      ),
    );
    await screen.findByRole("button", { name: "Download PDF" });
    expect(screen.queryByRole("button", { name: "Prepare isolated preview worker" }) === null).toBe(
      true,
    );
  });
});

describe("PDF attachment first-page preview", () => {
  function pdfResponse(
    overrides: Partial<TranscriptMediaPdfPreviewResponse>,
  ): TranscriptMediaPdfPreviewResponse {
    return {
      status: "ready",
      sha256: "9".repeat(64),
      byteLength: 40,
      pageCount: 3,
      thumbnail: { dataBase64: "iVBORw0KGgo=", mimeType: "image/png", width: 120, height: 160 },
      limits: { maxPages: 100, maxBytes: 20 * 1024 * 1024 },
      ...overrides,
    };
  }

  test("sources are only the authorized readers' inputs", () => {
    const scope = { environmentId: "env-1", logicalSessionKey: "session-1", agent: "claude" };
    expect(pdfPreviewSource({ path: "/Users/me/w/doc.pdf" }, scope)).toEqual({
      environmentId: "env-1",
      source: { path: "/Users/me/w/doc.pdf" },
    });
    expect(pdfPreviewSource({ path: "docs/a.pdf", containerId: "c1" }, scope)).toEqual({
      environmentId: "env-1",
      source: { path: "docs/a.pdf", containerId: "c1" },
    });
    expect(pdfPreviewSource({ path: "../etc/x.pdf", containerId: "c1" }, scope)).toBeNull();
    expect(pdfPreviewSource({ path: "", detailRef: "d1" }, scope)).toEqual({
      environmentId: "env-1",
      source: { detailRef: "d1", agent: "claude", logicalSessionKey: "session-1" },
    });
    // Inline-only bytes and remote URLs have no backend source.
    expect(
      pdfPreviewSource({ path: "x.pdf", fileUrl: "data:application/pdf;base64,JVBERg==" }, scope),
    ).toBeNull();
    expect(
      pdfPreviewSource({ path: "x.pdf", fileUrl: "https://example.com/x.pdf" }, scope),
    ).toBeNull();
    expect(pdfPreviewSource({ path: "/a.pdf" }, null)).toBeNull();
  });

  test("shows page 1 and the page count, with Download original kept", async () => {
    handler = (command) => {
      if (command === "read_file_base64") return PDF_BASE64;
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview) return pdfResponse({});
      return undefined;
    };
    render(wrap(<FilePreview reference={{ path: "/Users/me/w/doc.pdf" }} name="doc.pdf" />));
    fireEvent.click(screen.getByRole("button", { name: "Preview file: doc.pdf (PDF document)" }));
    const image = await screen.findByAltText("First page of doc.pdf");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview)).toEqual([
      { environmentId: "env-1", source: { path: "/Users/me/w/doc.pdf" } },
    ]);
    expect(document.querySelector("iframe, embed, object") === null).toBe(true);
  });

  test("over the page ceiling: metadata and download only", async () => {
    handler = (command) => {
      if (command === "read_file_base64") return PDF_BASE64;
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview)
        return pdfResponse({
          status: "refused",
          reason: "page-limit",
          pageCount: 140,
          thumbnail: undefined,
        });
      return undefined;
    };
    const { container } = render(
      wrap(<FilePreview reference={{ path: "/Users/me/w/long.pdf" }} name="long.pdf" />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: long.pdf (PDF document)" }));
    expect(await screen.findByText(/has 140 pages; first-page previews stop at 100/)).toBeTruthy();
    expect(
      container.ownerDocument.querySelector('[data-pdf-preview-reason="page-limit"]'),
    ).not.toBeNull();
    expect(screen.queryByAltText("First page of long.pdf") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
  });
});
