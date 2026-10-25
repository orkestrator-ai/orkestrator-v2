import { useEffect, useMemo, useRef, useLayoutEffect } from "react";
import type { ArtifactLiveSessionResponse } from "@orkestrator/protocol/transcript-artifact-commands";
import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFrameSession, artifactShellLocation } from "@/lib/chat/artifact-frame-session";
import {
  prefersReducedMotion,
  readArtifactThemeTokens,
  type AppAppearance,
} from "@/lib/chat/artifact-theme";
import type { LiveHostSession } from "@/stores/artifactLiveHostStore";

/**
 * Browser-mode executable document, loaded through the trusted viewer shell
 * (`session.shellUrl`, `/s/<capability>` on the dedicated content origin).
 * The shell frames exactly the prepared document in an opaque-origin
 * `sandbox="allow-scripts"` iframe; its `frame-src` names only that URL, so
 * the artifact cannot navigate its frame anywhere else (the application's
 * pages cannot carry such a `frame-src`: Browser tabs frame arbitrary URLs).
 *
 * The shell iframe itself is sandboxed with `allow-scripts allow-same-origin`
 * and no other privilege: it keeps the content origin (a different site from
 * the application, so never same-origin with this page), which lets this host
 * check `event.origin` and address it exactly, and lets the document's
 * `frame-ancestors` name it. The shell URL must be on the document's origin
 * and never on this page's origin, or nothing is loaded.
 *
 * Messages are accepted only from the captured shell window with the content
 * origin, through the strict channel parser and rate limiter. The shell's
 * `shell-disposed` (the artifact frame loaded again or tried to navigate) and
 * a second `load` of the shell both end the channel and show the saved
 * preview. Theme messages go to the shell window only, after `ready`.
 */

/** Generous allowance for the live document to announce readiness. */
export const LIVE_READY_TIMEOUT_MS = PREVIEW_ADMISSION_POLICY.readinessMs * 2;

/** The shell's sandbox: scripts and its own (content) origin only. */
export const ARTIFACT_SHELL_SANDBOX = "allow-scripts allow-same-origin";

const NAVIGATION_STOPPED = "The interactive document tried to navigate or reload and was stopped.";

type Report = (
  patch: Partial<Pick<LiveHostSession, "phase" | "message" | "linkRequest">> & { height?: number },
) => void;

export function ArtifactLiveHostFrame({
  session,
  title,
  appearance,
  report,
  readyTimeoutMs = LIVE_READY_TIMEOUT_MS,
}: {
  session: ArtifactLiveSessionResponse;
  title: string;
  appearance: AppAppearance;
  report: Report;
  readyTimeoutMs?: number;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shell = useMemo(() => artifactShellLocation(session, window.location.origin), [session]);
  const shellOrigin = shell?.origin ?? null;
  const channel = useMemo(
    () =>
      new ArtifactFrameSession({
        artifactId: session.artifactId,
        revision: session.revision,
        generation: session.generation,
        readinessNonce: session.readinessNonce,
        // Without a usable shell no frame is mounted; this origin then matches nothing.
        expectedOrigin: shellOrigin ?? "invalid:",
      }),
    [session.artifactId, session.generation, session.readinessNonce, session.revision, shellOrigin],
  );
  const reportRef = useRef(report);
  useLayoutEffect(() => {
    reportRef.current = report;
  });

  const sendTheme = useMemo(
    () => (nextAppearance: AppAppearance) => {
      const frame = frameRef.current;
      const target = frame?.contentWindow;
      if (!frame || !target || !shellOrigin) return;
      const message = channel.themeMessage({
        appearance: nextAppearance,
        reducedMotion: prefersReducedMotion(),
        viewport: { width: frame.clientWidth, height: frame.clientHeight },
        tokens: readArtifactThemeTokens(),
      });
      // Addressed to the shell's exact origin; the shell re-validates the
      // theme and hands it to the artifact frame it captured.
      if (message) target.postMessage(message, shellOrigin);
    },
    [channel, shellOrigin],
  );
  const appearanceRef = useRef(appearance);
  useLayoutEffect(() => {
    appearanceRef.current = appearance;
  });

  useEffect(() => {
    if (shell) return;
    reportRef.current({
      phase: "error",
      message: "The interactive view is unavailable: the backend did not provide a viewer shell.",
    });
  }, [shell]);

  useEffect(() => {
    if (!shell) return;
    const onMessage = (event: MessageEvent) => {
      const outcome = channel.handle(
        { source: event.source, data: event.data, origin: event.origin },
        frameRef.current?.contentWindow ?? null,
      );
      switch (outcome.kind) {
        case "ready":
          reportRef.current({ phase: "ready", message: null });
          sendTheme(appearanceRef.current);
          break;
        case "size":
          reportRef.current({ height: outcome.height });
          break;
        case "link":
          reportRef.current({
            linkRequest: { href: outcome.href, hostname: outcome.hostname, label: outcome.label },
          });
          break;
        case "disposed":
          // The shell already tore the artifact frame down; show the saved preview.
          reportRef.current({
            phase: "navigation-blocked",
            message: NAVIGATION_STOPPED,
            linkRequest: null,
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    const readyTimer = setTimeout(() => {
      if (!channel.ready) {
        reportRef.current({
          phase: "unresponsive",
          message: "The interactive view did not become ready.",
        });
      }
    }, readyTimeoutMs);
    return () => {
      clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
      channel.invalidate();
    };
  }, [channel, readyTimeoutMs, sendTheme, shell]);

  // Theme changes are presentation only; they never claim verification.
  useEffect(() => {
    if (channel.ready) sendTheme(appearance);
  }, [appearance, channel, sendTheme]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (channel.ready) sendTheme(appearanceRef.current);
      }, 250);
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [channel, sendTheme]);

  const loads = useRef(0);
  if (!shell) return null;
  return (
    <iframe
      ref={frameRef}
      title={`Interactive artifact: ${title}`}
      src={shell.url}
      sandbox={ARTIFACT_SHELL_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      data-artifact-live-frame={session.generation}
      className="block h-full w-full border-0 bg-background"
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) {
          // The shell itself reloaded or navigated: this channel is over.
          channel.invalidate();
          reportRef.current({
            phase: "navigation-blocked",
            message: NAVIGATION_STOPPED,
            linkRequest: null,
          });
        }
      }}
    />
  );
}
