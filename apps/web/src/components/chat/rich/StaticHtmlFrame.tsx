import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampArtifactFrameHeight } from "@orkestrator/protocol/artifact-frame-channel";
import {
  FRAME_CHANNEL_POLICY,
  STATIC_PRESENTATION_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import type {
  StaticHtmlFrameErrorCode,
  StaticHtmlFrameTheme,
} from "@orkestrator/protocol/static-html-presentation";
import {
  prefersReducedMotion,
  readStaticHtmlThemeTokens,
  useAppAppearance,
  type AppAppearance,
} from "@/lib/chat/artifact-theme";
import { StaticHtmlFrameSession } from "@/lib/chat/static-html-frame-session";
import { createUuid } from "@/lib/uuid";
import { noteStaticFrameEvent } from "@/stores/staticHtmlFrameSlots";
import { HOST_DETACHING_EVENT } from "@/lib/stable-host";
import { cn } from "@/lib/utils";
import { recordStaticFindMatch } from "../chat-find-context";
import { staticHtmlFrameSource } from "./static-html-frame-source";

export type StaticFrameFailure = StaticHtmlFrameErrorCode | "timeout" | "reloaded" | "unstable";

export interface StaticFrameEvents {
  onRendered: () => void;
  /** This mount is gone, so whatever it rendered is no longer on screen. */
  onReleased: () => void;
  /** Coalesced to the frame channel's size rate; the latest height always arrives. */
  onHeight: (height: number) => void;
  onFailure: (failure: StaticFrameFailure) => void;
  /** The rendered document's bounded text, reported whole, at most once per mount. */
  onText: (text: string) => void;
  onInteraction: (interacting: boolean) => void;
  onLink: (link: { href: string; hostname: string; label: string }) => void;
  onEscape: () => void;
}

function frameTheme(appearance: AppAppearance): StaticHtmlFrameTheme {
  return {
    appearance,
    reducedMotion: prefersReducedMotion(),
    tokens: readStaticHtmlThemeTokens(appearance),
  };
}

function mountId(): string {
  return createUuid().replaceAll("-", "");
}

function freshMount() {
  const nonce = mountId();
  return {
    nonce,
    source: staticHtmlFrameSource(nonce),
    session: new StaticHtmlFrameSession({ nonce, generation: mountId() }),
  };
}

/**
 * One mounted static document. A presentation-only surface: it posts the
 * verified document once to its own freshly loaded frame and reports what the
 * frame says. It publishes nothing and invokes no backend command. Mount it
 * with a new `key` for a retry, which is what gives the retry a fresh frame and
 * bridge identity.
 */
export function StaticHtmlFrame({
  html,
  title,
  verifiedAppearance,
  mode,
  height,
  rendered,
  findQuery,
  findOccurrence,
  events,
}: {
  html: string;
  title: string;
  /** The receipt's profile, for a document that names no theme token. */
  verifiedAppearance: AppAppearance;
  mode: "inline" | "expanded";
  /** The inline height to apply; ignored in expanded mode, which fills its container. */
  height: number;
  rendered: boolean;
  /** An open Find bar's query; null when there is none. */
  findQuery: string | null;
  /** The active match, when it is in this document. */
  findOccurrence: number | null;
  events: StaticFrameEvents;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(freshMount);
  const appearance = useAppAppearance();
  const [themed, setThemed] = useState(true);
  const latest = useRef({ html, appearance, verifiedAppearance, events });
  useLayoutEffect(() => {
    latest.current = { html, appearance, verifiedAppearance, events };
  });

  useEffect(() => {
    const { session } = mount;
    let settled = false;
    let lastSizeAt = -Infinity;
    let pendingSize: ReturnType<typeof setTimeout> | null = null;
    let pendingHeight: number | null = null;
    const fail = (failure: StaticFrameFailure) => {
      if (failure === "reloaded") noteStaticFrameEvent("framesReloaded");
      else noteStaticFrameEvent("framesFailed");
      latest.current.events.onFailure(failure);
    };
    const flushSize = () => {
      pendingSize = null;
      if (pendingHeight === null) return;
      lastSizeAt = Date.now();
      latest.current.events.onHeight(pendingHeight);
      pendingHeight = null;
    };
    const reportSize = (next: number) => {
      pendingHeight = next;
      if (pendingSize !== null) return;
      const spacing = 1000 / FRAME_CHANNEL_POLICY.sizeUpdatesPerSecond;
      const wait = Math.max(0, lastSizeAt + spacing - Date.now());
      if (wait === 0) flushSize();
      else pendingSize = setTimeout(flushSize, wait);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      session.invalidate();
      fail("timeout");
    }, STATIC_PRESENTATION_POLICY.renderTimeoutMs);
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframe.current?.contentWindow;
      const outcome = session.handle(event, frameWindow);
      switch (outcome.kind) {
        case "ready": {
          const message = session.renderMessage(
            latest.current.html,
            frameTheme(latest.current.appearance),
            latest.current.verifiedAppearance,
          );
          // An opaque frame has no origin to name. Only this frame's window,
          // proven just now by its own nonce, receives the document.
          if (message && frameWindow) frameWindow.postMessage(message, "*");
          break;
        }
        case "rendered":
          settled = true;
          clearTimeout(timeout);
          setThemed(outcome.themed);
          latest.current.events.onHeight(outcome.height);
          latest.current.events.onRendered();
          break;
        case "text":
          latest.current.events.onText(outcome.text);
          break;
        case "size":
          reportSize(outcome.height);
          break;
        case "error":
          settled = true;
          clearTimeout(timeout);
          fail(outcome.code);
          break;
        case "reloaded":
        case "unstable":
          settled = true;
          clearTimeout(timeout);
          fail(outcome.kind);
          break;
        case "interaction":
          latest.current.events.onInteraction(
            outcome.focused || outcome.hasSelection || outcome.pointerSelecting,
          );
          break;
        case "link":
          latest.current.events.onLink({
            href: outcome.href,
            hostname: outcome.hostname,
            label: outcome.label,
          });
          break;
        case "escape":
          latest.current.events.onEscape();
          break;
        case "find-match":
          if (iframe.current) recordStaticFindMatch(iframe.current, outcome);
          break;
        case "text-partial":
        case "rejected":
          break;
      }
    };
    const element = iframe.current;
    const onDetaching = () => {
      // Never resend into the document reloaded by appendChild. Retire the old
      // channel synchronously, then replace the iframe with a new identity.
      session.invalidate();
      settled = true;
      clearTimeout(timeout);
      setMount(freshMount());
    };
    element?.addEventListener(HOST_DETACHING_EVENT, onDetaching);
    window.addEventListener("message", onMessage);
    return () => {
      element?.removeEventListener(HOST_DETACHING_EVENT, onDetaching);
      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      if (pendingSize !== null) clearTimeout(pendingSize);
      latest.current.events.onReleased();
    };
  }, [mount]);

  useEffect(() => {
    noteStaticFrameEvent("framesMounted");
  }, [mount]);

  // A theme change is a new presentation of the same document: no preview job,
  // no new revision, no reload.
  useEffect(() => {
    const message = mount.session.themeMessage(frameTheme(appearance));
    if (message) iframe.current?.contentWindow?.postMessage(message, "*");
    // `rendered` too: a theme change during the handshake still reaches the frame.
  }, [mount, appearance, rendered]);

  // Only this mount's frame hears the query, once it has a document to search.
  useEffect(() => {
    const message = mount.session.findMessage(findQuery ?? "", findOccurrence);
    if (!message) return;
    if (iframe.current) recordStaticFindMatch(iframe.current, null);
    iframe.current?.contentWindow?.postMessage(message, "*");
  }, [mount, rendered, findQuery, findOccurrence]);

  return (
    <iframe
      key={mount.nonce}
      ref={iframe}
      title={`Report: ${title}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-artifact-static-document="true"
      data-state={rendered ? "rendered" : "rendering"}
      data-mode={mode}
      {...mount.source}
      {...(rendered ? {} : { tabIndex: -1, "aria-hidden": true })}
      onLoad={() => {
        const outcome = mount.session.noteLoad();
        if (outcome?.kind !== "reloaded") return;
        noteStaticFrameEvent("framesReloaded");
        latest.current.events.onFailure("reloaded");
      }}
      className={cn(
        "block w-full border-0 bg-transparent",
        mode === "expanded" && "h-full",
        !rendered && "pointer-events-none absolute inset-x-0 top-0 opacity-0",
      )}
      // A frame whose scheme differs from this element's gets an opaque browser
      // canvas, which would paint over a transparent themed document.
      style={{
        colorScheme: themed ? appearance : verifiedAppearance,
        ...(mode === "inline" ? { height: clampArtifactFrameHeight(height) } : {}),
      }}
    />
  );
}
