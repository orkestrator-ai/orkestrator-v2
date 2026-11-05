import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { sha256Hex } from "@orkestrator/protocol/graphs/sha256";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
  type ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { STATIC_HTML_FRAME_CHANNEL } from "@orkestrator/protocol/static-html-presentation";
import {
  artifactPartContent,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  clearArtifactRequestCache,
  resetArtifactConversationRevocations,
  revokeArtifactConversation,
} from "@/lib/chat/artifact-requests";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { resetStaticFrameSlots, staticFrameSlotStats } from "@/stores/staticHtmlFrameSlots";
import { ArtifactPart } from "./ArtifactPart";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const BACKEND = "backend-1";
const HTML = "<!doctype html><h1 style='color:var(--ork-foreground)'>Report</h1>";
const CAPTURE = "iVBORw0KGgo=";

const REF: TranscriptArtifactRef = {
  schemaVersion: 1,
  artifactId: "art_abcdefgh1",
  revision: 2,
  publicationId: "pub_abcdefgh1",
  kind: "html-static",
  title: "Report title",
  summary: "A synthetic summary",
  provenance: { backendId: BACKEND, origin: "agent" },
};

const PART = {
  type: "artifact",
  content: artifactPartContent(REF),
  artifact: REF,
  publishedAt: "2026-11-04T10:00:00.000Z",
  conversationSequence: 1,
} as NativeArtifactPart;

function publication(overrides: Partial<ArtifactPublicationView> = {}): ArtifactPublicationView {
  return {
    ref: REF,
    publishedAt: "2026-11-04T10:00:00.000Z",
    conversationSequence: 1,
    kind: "html-static",
    receipt: {
      receiptId: "rcpt_abcdefgh1",
      completedAt: "2026-11-04T09:59:00.000Z",
      profile: { theme: "light", viewport: { width: 960, height: 640, deviceScaleFactor: 1 } },
      captures: [
        { assetId: "asset_a", sha256: "c".repeat(64), width: 960, height: 640, byteLength: 10 },
      ],
      semantics: "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: sha256Hex(HTML) },
    availability: "available",
    ...overrides,
  };
}

function effective(html = HTML): ArtifactRepresentationResponse {
  const bytes = new TextEncoder().encode(html).byteLength;
  return {
    artifactId: REF.artifactId,
    revision: REF.revision,
    representation: "effective-html",
    mimeType: "text/html; charset=utf-8",
    filename: "report.html",
    encoding: "utf8",
    data: html,
    sha256: sha256Hex(html),
    byteLength: bytes,
    totalBytes: bytes,
    nextOffsetBytes: null,
    executableOutsideOrkestrator: true,
  };
}

const capture: ArtifactRepresentationResponse = {
  artifactId: REF.artifactId,
  revision: REF.revision,
  representation: "capture",
  mimeType: "image/png",
  filename: "capture.png",
  encoding: "base64",
  data: CAPTURE,
  sha256: "c".repeat(64),
  byteLength: CAPTURE.length,
  totalBytes: CAPTURE.length,
  nextOffsetBytes: null,
  executableOutsideOrkestrator: false,
};

const capabilities = {
  backendId: BACKEND,
  authoring: true,
  previewRenderer: { available: false, isolation: "unavailable", reason: "Not installed" },
  liveInteractive: false,
  contentOrigin: null,
  rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: false },
};

let readEffective: () => unknown = () => effective();
let flags: Record<string, boolean> = {};

function calls(representation: string): number {
  return invokeMock.mock.calls.filter(
    (call) =>
      call[0] === TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation &&
      (call[1] as { representation?: string }).representation === representation,
  ).length;
}

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

function frameElement(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector<HTMLIFrameElement>('iframe[data-artifact-static-document="true"]');
}

async function awaitFrame(container: HTMLElement): Promise<HTMLIFrameElement> {
  await waitFor(() => expect(frameElement(container)).not.toBeNull());
  return frameElement(container)!;
}

function nonceOf(iframe: HTMLIFrameElement): string {
  const srcdoc = iframe.getAttribute("srcdoc") ?? "";
  return /script-src 'nonce-([^']+)'/.exec(srcdoc)![1]!;
}

function fromFrame(iframe: HTMLIFrameElement, data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, ...data },
      }),
    );
  });
}

/** Drive a mount through the handshake the real runtime performs. */
function completeHandshake(iframe: HTMLIFrameElement): { render: Record<string, unknown> } {
  const posted: Array<Record<string, unknown>> = [];
  iframe.contentWindow!.postMessage = ((message: Record<string, unknown>) => {
    posted.push(message);
  }) as never;
  fromFrame(iframe, { type: "ready", nonce: nonceOf(iframe) });
  const render = posted.find((message) => message.type === "render");
  if (!render) throw new Error("The host did not send the document");
  fromFrame(iframe, {
    type: "rendered",
    generation: render.generation,
    height: 500,
    elementCount: 3,
    themed: true,
  });
  return { render };
}

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  resetArtifactConversationRevocations();
  resetStaticFrameSlots();
  useRichContentViewStore.getState().reset();
  useArtifactLiveHostStore.getState().resetForTests();
  readEffective = () => effective();
  flags = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case TRANSCRIPT_ARTIFACT_COMMANDS.capabilities:
        return Promise.resolve({
          ...capabilities,
          rolloutFlags: { ...capabilities.rolloutFlags, ...flags },
        });
      case TRANSCRIPT_ARTIFACT_COMMANDS.getPublication:
        return Promise.resolve(publication());
      case TRANSCRIPT_ARTIFACT_COMMANDS.listPublications:
        return Promise.resolve({ publications: [publication()], nextSequence: null });
      case TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation:
        if (args.representation === "capture") return Promise.resolve(capture);
        if (args.representation === "effective-html") {
          try {
            return Promise.resolve(readEffective());
          } catch (error) {
            return Promise.reject(error);
          }
        }
        return Promise.reject(new Error(`Unexpected ${String(args.representation)}`));
      default:
        return Promise.reject(new Error(`Unexpected ${command}`));
    }
  });
});

afterEach(() => cleanup());

describe("StaticHtmlArtifactView", () => {
  test("replaces the saved preview with the verified document, without a preview worker", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.dataset.state).toBe("rendering");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    const { render: message } = completeHandshake(iframe);
    expect(message.html).toBe(HTML);
    expect(message.verifiedAppearance).toBe("light");
    expect(iframe.dataset.state).toBe("rendered");
    expect(iframe.hasAttribute("aria-hidden")).toBe(false);
    expect(iframe.title).toBe("Report: Report title");
    expect(container.querySelector('[data-artifact-capture="true"]')).toBeNull();
  });

  test("a stale height from an earlier visit reserves space while the frame returns", async () => {
    useRichContentViewStore.getState().update("seed", { measuredHeight: 1 });
    const { container, unmount } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    completeHandshake(iframe);
    await waitFor(() => expect(iframe.style.height).toBe("500px"));
    unmount();
    const second = render(wrap(<ArtifactPart part={PART} />));
    const again = await awaitFrame(second.container);
    expect(again.style.height).toBe("500px");
    expect(calls("effective-html")).toBe(1);
  });

  test("an interaction keeps its rank, and a re-render does not reload the frame", async () => {
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick(tick + 1)}>
            Stream {tick}
          </button>
          {wrap(<ArtifactPart part={PART} />)}
        </>
      );
    }
    const { container } = render(<Host />);
    const iframe = await awaitFrame(container);
    const { render: message } = completeHandshake(iframe);
    const mounted = staticFrameSlotStats().framesMounted;
    for (let tick = 0; tick < 5; tick++)
      fireEvent.click(screen.getByRole("button", { name: `Stream ${tick}` }));
    fromFrame(iframe, {
      type: "interaction",
      generation: message.generation,
      focused: true,
      hasSelection: true,
      pointerSelecting: false,
    });
    expect(frameElement(container)).toBe(iframe);
    expect(staticFrameSlotStats().framesMounted).toBe(mounted);
    expect(calls("effective-html")).toBe(1);
  });

  test("a reader's revocation clears the document and every protected fallback", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    completeHandshake(iframe);
    await act(async () => {
      revokeArtifactConversation(scope(), "permission");
      await Bun.sleep(0);
    });
    await waitFor(() => expect(frameElement(container)).toBeNull());
    expect(container.querySelector('[data-artifact-capture="true"]')).toBeNull();
    expect(container.textContent).not.toContain("Report title Revision");
    expect(staticFrameSlotStats().granted).toBe(0);
  });

  test("a scope generation change never shows the old conversation's document", async () => {
    const { container, rerender } = render(wrap(<ArtifactPart part={PART} />, "g1"));
    const first = await awaitFrame(container);
    completeHandshake(first);
    let release: (value: unknown) => void = () => {};
    readEffective = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    rerender(wrap(<ArtifactPart part={PART} />, "g2"));
    await waitFor(() => expect(frameElement(container)).toBeNull());
    await waitFor(() => expect(calls("effective-html")).toBe(2));
    expect(frameElement(container)).toBeNull();
    await act(async () => {
      release(effective());
      await Bun.sleep(0);
    });
    const fresh = await awaitFrame(container);
    expect(fresh).not.toBe(first);
  });

  test("a transport failure offers retry and keeps the saved preview", async () => {
    readEffective = () => {
      throw new Error("socket closed");
    };
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    await waitFor(() => expect(screen.getByText("The document could not be loaded.")).toBeTruthy());
    expect(frameElement(container)).toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    readEffective = () => effective();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await awaitFrame(container);
  });

  test("a retry mounts a fresh frame with a fresh identity", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    const { render: message } = completeHandshake(iframe);
    fromFrame(iframe, { type: "error", generation: message.generation, code: "render-failed" });
    await waitFor(() => expect(frameElement(container)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const fresh = await awaitFrame(container);
    expect(fresh).not.toBe(iframe);
    expect(nonceOf(fresh)).not.toBe(nonceOf(iframe));
    const { render: next } = completeHandshake(fresh);
    expect(next.generation).not.toBe(message.generation);
  });

  test("a frame that loses its mount goes back to the saved preview until it renders again", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    completeHandshake(iframe);
    expect(iframe.dataset.state).toBe("rendered");
    fireEvent.click(screen.getByRole("button", { name: "Saved preview" }));
    await waitFor(() => expect(frameElement(container)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Document" }));
    const fresh = await awaitFrame(container);
    expect(fresh).not.toBe(iframe);
    expect(fresh.dataset.state).toBe("rendering");
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
  });

  test("a frame that never renders is released with retry, keeping the saved preview", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let expire: (() => void) | null = null;
    globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay === STATIC_PRESENTATION_POLICY.renderTimeoutMs) {
        expire = handler;
        return 0;
      }
      return realSetTimeout(handler, delay, ...rest);
    }) as typeof setTimeout;
    try {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      await awaitFrame(container);
      await waitFor(() => expect(expire).not.toBeNull());
      await waitFor(() =>
        expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
      );
      act(() => expire!());
      await waitFor(() =>
        expect(screen.getByText("The document view did not respond.")).toBeTruthy(),
      );
      expect(frameElement(container)).toBeNull();
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("an explicit frame budget error is unavailable, not retried", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    const { render: message } = completeHandshake(iframe);
    fromFrame(iframe, { type: "error", generation: message.generation, code: "too-many-elements" });
    await waitFor(() => expect(screen.getByText(/more than 5000 elements/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("the rollback flag keeps the saved preview and removes the document view", async () => {
    flags = { staticPresentation: false };
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy());
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Document" })).toBeNull();
    expect(frameElement(container)).toBeNull();
  });
});
