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
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
} from "@orkestrator/protocol/static-html-presentation";
import {
  artifactPartContent,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  artifactSearchBodyWithheld,
  cachedArtifactSearchBody,
  clearArtifactRequestCache,
  clearArtifactRequestsForConversation,
  clearArtifactRequestsForEnvironment,
  rememberArtifactSearchBody,
  resetArtifactConversationRevocations,
  revokeArtifactConversation,
} from "@/lib/chat/artifact-requests";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import { artifactPartSearchSegments } from "@/lib/chat/rich-search-text";
import { searchRootText } from "@/lib/chat/rich-markdown/find-reveal";
import { findAgentChatMatches } from "@/components/chat/AgentChatFind";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import {
  ChatFindActiveContext,
  STATIC_FIND_MATCH_EVENT,
  StaticDocumentFindContext,
  staticDocumentMatchRect,
  type StaticDocumentFind,
} from "@/components/chat/chat-find-context";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import {
  resetStaticFrameSlots,
  setStaticFrameClaim,
  staticFrameSlotStats,
} from "@/stores/staticHtmlFrameSlots";
import { parkHost, placeHost } from "@/lib/stable-host";
import { ArtifactPart } from "./ArtifactPart";
import { cardsShowDocument } from "../static-document-search-index";

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
function completeHandshake(iframe: HTMLIFrameElement): {
  render: Record<string, unknown>;
  posted: Array<Record<string, unknown>>;
} {
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
  return { render, posted };
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
    expect(container.querySelector('[data-artifact-capture="true"]') === null).toBe(true);
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
    expect(container.querySelector('[data-artifact-capture="true"]') === null).toBe(true);
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

  test("fallback host moves replace the frame and channel without a manual retry", async () => {
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    const iframe = await awaitFrame(container);
    const { render: old } = completeHandshake(iframe);
    const originalParent = container.parentElement!;
    const park = document.createElement("div");
    document.body.appendChild(park);
    act(() => {
      parkHost(container, park);
      placeHost(container, originalParent);
    });
    const fresh = await awaitFrame(container);
    expect(fresh).not.toBe(iframe);
    expect(nonceOf(fresh)).not.toBe(nonceOf(iframe));
    const { render: next } = completeHandshake(fresh);
    expect(next.generation).not.toBe(old.generation);
    expect(fresh.dataset.state).toBe("rendered");
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    park.remove();
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
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
  });

  describe("document text in Find", () => {
    const BODY_TEXT = "Quarterly quokka census";

    function report(iframe: HTMLIFrameElement, generation: unknown, text = BODY_TEXT): void {
      fromFrame(iframe, { type: "text", generation, index: 0, count: 1, text });
    }

    async function shownDocument(container: HTMLElement) {
      const iframe = await awaitFrame(container);
      const { render: message } = completeHandshake(iframe);
      return { iframe, generation: message.generation };
    }

    function domSegments(container: HTMLElement): string[] {
      return Array.from(
        container.querySelectorAll<HTMLElement>("[data-agent-chat-search-content]"),
      ).map(searchRootText);
    }

    function indexed(): string[] {
      return artifactPartSearchSegments(PART, cachedArtifactSearchBody(REF));
    }

    function findMatches(query: string): number {
      const message = { id: "m1", role: "assistant", content: "", parts: [PART] };
      const text = getNativeMessageSearchText(
        message as unknown as Parameters<typeof getNativeMessageSearchText>[0],
      );
      return findAgentChatMatches([text], query).length;
    }

    test("Find matches the body once the frame reports it, with the card's search root to match", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      expect(findMatches("summary")).toBe(1);
      expect(findMatches("quokka")).toBe(0);
      expect(domSegments(container)).toEqual(indexed());

      report(iframe, generation);
      expect(findMatches("quokka")).toBe(1);
      expect(indexed()).toEqual(["A synthetic summary", BODY_TEXT]);
      await waitFor(() => expect(domSegments(container)).toEqual(indexed()));
      // The mirror is hidden from the reader, and the host never parsed the document.
      const mirror = container.querySelector<HTMLElement>("[data-rich-search-mirror]")!;
      expect(mirror.hidden).toBe(true);
      expect(mirror.children).toHaveLength(0);
    });

    test("markup in reported text stays text", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      const hostile = "<img src=x onerror=alert(1)>";
      report(iframe, generation, hostile);
      await waitFor(() => expect(domSegments(container)).toContain(hostile));
      const mirror = container.querySelector<HTMLElement>("[data-rich-search-mirror]")!;
      expect(mirror.querySelector("img") === null).toBe(true);
    });

    test("scrolling the card away keeps the text, and its return restores the search root at once", async () => {
      const first = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(first.container);
      report(iframe, generation);
      first.unmount();
      expect(indexed()).toEqual(["A synthetic summary", BODY_TEXT]);
      const second = render(wrap(<ArtifactPart part={PART} />));
      await waitFor(() => expect(domSegments(second.container)).toEqual(indexed()));
    });

    test("a view that does not show the document withdraws its text until it returns", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      report(iframe, generation);
      expect(findMatches("quokka")).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "Saved preview" }));
      await waitFor(() => expect(findMatches("quokka")).toBe(0));
      expect(domSegments(container)).toEqual(["A synthetic summary"]);

      fireEvent.click(screen.getByRole("button", { name: "Document" }));
      const { iframe: fresh, generation: next } = await shownDocument(container);
      report(fresh, next);
      expect(findMatches("quokka")).toBe(1);
    });

    test("a frame that fails withdraws the text, and a retry brings it back", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      report(iframe, generation);
      fromFrame(iframe, { type: "error", generation, code: "render-failed" });
      await waitFor(() => expect(frameElement(container)).toBeNull());
      expect(findMatches("quokka")).toBe(0);
      expect(domSegments(container)).toEqual(["A synthetic summary"]);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const { iframe: fresh, generation: next } = await shownDocument(container);
      report(fresh, next);
      expect(findMatches("quokka")).toBe(1);
    });

    test("a failed frame keeps Find's index out until a Retry displays the document again", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      expect(artifactSearchBodyWithheld(REF)).toBe(false);
      fromFrame(iframe, { type: "error", generation, code: "render-failed" });
      await waitFor(() => expect(frameElement(container)).toBeNull());
      expect(artifactSearchBodyWithheld(REF)).toBe(true);
      expect(cardsShowDocument(scope(), REF)).toBe(false);
      // Scrolling away does not forget the failure the card still shows.
      cleanup();
      expect(artifactSearchBodyWithheld(REF)).toBe(true);

      const again = render(wrap(<ArtifactPart part={PART} />));
      await shownDocument(again.container);
      expect(artifactSearchBodyWithheld(REF)).toBe(false);
      expect(cardsShowDocument(scope(), REF)).toBe(true);
    });

    test("a frame over the element limit and a read over the budget both withhold the document", async () => {
      const first = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(first.container);
      fromFrame(iframe, { type: "error", generation, code: "too-many-elements" });
      await waitFor(() => expect(screen.getByText(/more than 5000 elements/)).toBeTruthy());
      expect(artifactSearchBodyWithheld(REF)).toBe(true);
      cleanup();
      clearArtifactRequestCache();
      expect(artifactSearchBodyWithheld(REF)).toBe(false);

      readEffective = () => ({
        ...effective(),
        totalBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes + 1,
      });
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      await waitFor(() =>
        expect(
          container.querySelector('[data-artifact-static-state="unavailable"]'),
        ).not.toBeNull(),
      );
      expect(artifactSearchBodyWithheld(REF)).toBe(true);
      expect(findMatches("quokka")).toBe(0);
    });

    test("a read failure is withheld too, and a successful Retry releases it", async () => {
      readEffective = () => {
        throw new Error("socket closed");
      };
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      await waitFor(() =>
        expect(screen.getByText("The document could not be loaded.")).toBeTruthy(),
      );
      expect(artifactSearchBodyWithheld(REF)).toBe(true);
      readEffective = () => effective();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await shownDocument(container);
      expect(artifactSearchBodyWithheld(REF)).toBe(false);
    });

    test("a re-read that fails withdraws text from an earlier visit", async () => {
      const first = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(first.container);
      report(iframe, generation);
      first.unmount();
      readEffective = () => {
        throw new Error("socket closed");
      };
      // Under a new generation the card has to read the document again.
      render(wrap(<ArtifactPart part={PART} />, "g2"));
      await waitFor(() =>
        expect(screen.getByText("The document could not be loaded.")).toBeTruthy(),
      );
      await waitFor(() => expect(findMatches("quokka")).toBe(0));
    });

    test("the expanded view's frame reports the text too", async () => {
      flags = {};
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      await shownDocument(container);
      fireEvent.click(screen.getByRole("button", { name: "Expand document" }));
      const dialog = await waitFor(() => {
        const frame = document.querySelector<HTMLIFrameElement>(
          'iframe[data-artifact-static-document="true"][data-mode="expanded"]',
        );
        expect(frame).not.toBeNull();
        return frame!;
      });
      const { render: message } = completeHandshake(dialog);
      report(dialog, message.generation);
      expect(findMatches("quokka")).toBe(1);
    });

    test("revoking the conversation takes the text even while the card is scrolled away", async () => {
      const { container, unmount } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      report(iframe, generation);
      unmount();
      revokeArtifactConversation(scope(), "permission");
      expect(findMatches("quokka")).toBe(0);
    });

    test("revoking the conversation clears a mounted card's search root", async () => {
      const { container } = render(wrap(<ArtifactPart part={PART} />));
      const { iframe, generation } = await shownDocument(container);
      report(iframe, generation);
      await waitFor(() => expect(domSegments(container)).toContain(BODY_TEXT));
      await act(async () => {
        revokeArtifactConversation(scope(), "permission");
        await Bun.sleep(0);
      });
      await waitFor(() => expect(domSegments(container)).not.toContain(BODY_TEXT));
      expect(findMatches("quokka")).toBe(0);
    });

    test("clearing another conversation leaves the text; clearing this one or its environment takes it", async () => {
      const seen = () => findMatches("quokka");
      for (const clear of [
        () =>
          clearArtifactRequestsForConversation({
            backendId: BACKEND,
            environmentId: "env-1",
            logicalSessionKey: "session-1",
          }),
        () => clearArtifactRequestsForEnvironment("env-1"),
      ]) {
        const { container, unmount } = render(wrap(<ArtifactPart part={PART} />));
        const { iframe, generation } = await shownDocument(container);
        report(iframe, generation);
        unmount();
        clearArtifactRequestsForConversation({
          backendId: BACKEND,
          environmentId: "env-1",
          logicalSessionKey: "other-session",
        });
        clearArtifactRequestsForEnvironment("other-env");
        expect(seen()).toBe(1);
        clear();
        expect(seen()).toBe(0);
      }
    });
  });

  describe("Find inside the document", () => {
    const finding = (
      query: string,
      activeOccurrence: number | null = null,
      activePublicationId: string | null = activeOccurrence === null ? null : REF.publicationId,
    ): StaticDocumentFind => ({ query, activePublicationId, activeOccurrence });

    function withFind(find: StaticDocumentFind | null, activeRow = true) {
      return wrap(
        <StaticDocumentFindContext value={find}>
          <ChatFindActiveContext value={activeRow}>
            <RichMessageContext value={{ messageId: activeRow ? "m1" : "m2", role: "assistant" }}>
              <ArtifactPart part={PART} />
            </RichMessageContext>
          </ChatFindActiveContext>
        </StaticDocumentFindContext>,
      );
    }

    const finds = (posted: Array<Record<string, unknown>>) =>
      posted
        .filter((message) => message.type === "find")
        .map(({ query, occurrence }) => ({ query, occurrence }));

    test("asks its frame only once it has a document, then follows the active match", async () => {
      const view = render(withFind(finding("quokka", 2)));
      const iframe = await awaitFrame(view.container);
      const { posted, render: renderMessage } = completeHandshake(iframe);
      await waitFor(() => expect(finds(posted)).toEqual([{ query: "quokka", occurrence: 2 }]));
      expect(posted.find((message) => message.type === "find")).toEqual({
        channel: STATIC_HTML_FRAME_CHANNEL,
        v: 1,
        type: "find",
        generation: renderMessage.generation,
        query: "quokka",
        occurrence: 2,
      });

      fromFrame(iframe, {
        type: "find-match",
        generation: renderMessage.generation,
        top: 240,
        height: 16,
      });
      expect(iframe.dataset.findMatchTop).toBe("240");
      view.rerender(withFind(finding("quokka", 3)));
      await waitFor(() => expect(finds(posted).at(-1)).toEqual({ query: "quokka", occurrence: 3 }));
      expect(iframe.dataset.findMatchTop).toBeUndefined();

      // The same request is not sent twice however often the card renders.
      const sent = finds(posted).length;
      view.rerender(withFind(finding("quokka", 3)));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finds(posted)).toHaveLength(sent);
    });

    test("a match in another document leaves this one with no active occurrence", async () => {
      const { container } = render(withFind(finding("quokka", 4, "pub_someoneelse")));
      const { posted } = completeHandshake(await awaitFrame(container));
      await waitFor(() => expect(finds(posted)).toEqual([{ query: "quokka", occurrence: null }]));
    });

    test("closing Find clears the frame, and a card that never searched hears nothing", async () => {
      const view = render(withFind(null));
      const { posted } = completeHandshake(await awaitFrame(view.container));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finds(posted)).toEqual([]);
      view.rerender(withFind(finding("quokka", 0)));
      await waitFor(() => expect(finds(posted)).toHaveLength(1));
      view.rerender(withFind(null));
      await waitFor(() => expect(finds(posted).at(-1)).toEqual({ query: "", occurrence: null }));
    });

    test("a query past the channel's limit is not sent, and clears what was", async () => {
      const view = render(withFind(finding("quokka", 0)));
      const iframe = await awaitFrame(view.container);
      const { posted, render: message } = completeHandshake(iframe);
      await waitFor(() => expect(finds(posted)).toHaveLength(1));
      fromFrame(iframe, {
        type: "text",
        generation: message.generation,
        index: 0,
        count: 1,
        text: "quokka",
      });
      const mirror = await waitFor(() => {
        const element = view.container.querySelector("[data-rich-search-mirror]");
        expect(element).not.toBeNull();
        return element!;
      });
      fromFrame(iframe, {
        type: "find-match",
        generation: message.generation,
        top: 240,
        height: 16,
      });
      expect(staticDocumentMatchRect(mirror)).not.toBeNull();
      view.rerender(withFind(finding("x".repeat(STATIC_HTML_MAX_FIND_QUERY_CHARACTERS + 1), 0)));
      await waitFor(() => expect(finds(posted).at(-1)).toEqual({ query: "", occurrence: null }));
      expect(staticDocumentMatchRect(mirror)).toBeNull();
    });

    test("only the selected row activates a repeated publication", async () => {
      const selected = render(withFind(finding("quokka", 1)));
      const other = render(withFind(finding("quokka", 1), false));
      const first = completeHandshake(await awaitFrame(selected.container));
      const second = completeHandshake(await awaitFrame(other.container));
      await waitFor(() =>
        expect(finds(first.posted)).toEqual([{ query: "quokka", occurrence: 1 }]),
      );
      await waitFor(() =>
        expect(finds(second.posted)).toEqual([{ query: "quokka", occurrence: null }]),
      );
    });

    test("a remounted frame is told again", async () => {
      const view = render(withFind(finding("quokka", 1)));
      const { posted } = completeHandshake(await awaitFrame(view.container));
      await waitFor(() => expect(finds(posted)).toHaveLength(1));
      view.unmount();
      const second = render(withFind(finding("quokka", 1)));
      const { posted: again } = completeHandshake(await awaitFrame(second.container));
      await waitFor(() => expect(finds(again)).toEqual([{ query: "quokka", occurrence: 1 }]));
    });

    test("the frame's report positions the match, and the query stays out of the page", async () => {
      const view = render(withFind(finding("quokka", 0)));
      const iframe = await awaitFrame(view.container);
      const { render: renderMessage } = completeHandshake(iframe);
      fromFrame(iframe, {
        type: "text",
        generation: renderMessage.generation,
        index: 0,
        count: 1,
        text: "Quarterly quokka census",
      });
      const mirror = await waitFor(() => {
        const element = view.container.querySelector("[data-rich-search-mirror]");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(staticDocumentMatchRect(mirror)).toBeNull();

      let told = 0;
      view.container.addEventListener(STATIC_FIND_MATCH_EVENT, () => {
        told += 1;
      });
      iframe.getBoundingClientRect = () => new DOMRect(10, 100, 500, 600);
      fromFrame(iframe, {
        type: "find-match",
        generation: renderMessage.generation,
        top: 240,
        height: 16,
      });
      expect(told).toBe(1);
      const box = staticDocumentMatchRect(mirror)!;
      expect([box.left, box.top, box.width, box.height]).toEqual([10, 340, 500, 16]);
      // The mirror holds the document's own text; the query itself is nowhere in the page.
      expect(
        document.documentElement.outerHTML.replace("Quarterly quokka census", ""),
      ).not.toContain("quokka");

      // Not laid out (hidden by the document's CSS): back to the card.
      fromFrame(iframe, {
        type: "find-match",
        generation: renderMessage.generation,
        top: 0,
        height: 0,
      });
      expect(staticDocumentMatchRect(mirror)).toBeNull();
      fromFrame(iframe, {
        type: "find-match",
        generation: renderMessage.generation,
        top: 240,
        height: 16,
      });
      view.rerender(withFind(finding("quokka", null)));
      await waitFor(() => expect(staticDocumentMatchRect(mirror)).toBeNull());
    });

    test("a deferred card has no frame to ask and behaves as it did", async () => {
      for (let index = 0; index < STATIC_PRESENTATION_POLICY.maxFramesPerWindow; index++)
        setStaticFrameClaim(`other-${index}`, "expanded");
      rememberArtifactSearchBody(REF, "Quarterly quokka census", {
        backendId: BACKEND,
        environmentId: "env-1",
        logicalSessionKey: "session-1",
      });
      const { container } = render(withFind(finding("quokka", 0)));
      await waitFor(() =>
        expect(container.querySelector('[data-artifact-static-state="deferred"]')).not.toBeNull(),
      );
      expect(frameElement(container)).toBeNull();
      // Find still counts its text and leads to its card, through the mirror.
      const mirror = container.querySelector("[data-rich-search-mirror]")!;
      expect(mirror.textContent).toBe("Quarterly quokka census");
      expect(staticDocumentMatchRect(mirror)).toBeNull();
    });
  });

  test("the rollback flag keeps the saved preview and removes the document view", async () => {
    flags = { staticPresentation: false };
    const { container } = render(wrap(<ArtifactPart part={PART} />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy());
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-capture="true"]')).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Document" }) === null).toBe(true);
    expect(frameElement(container)).toBeNull();
  });
});
