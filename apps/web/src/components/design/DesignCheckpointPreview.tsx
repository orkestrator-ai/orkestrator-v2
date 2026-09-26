import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { createUuid } from "@/lib/uuid";
import { DesignFrameBridge } from "./frame-bridge";

/** The only bridge surface a preview uses: it renders, never edits. */
export type DesignPreviewBridge = Pick<DesignFrameBridge, "ask" | "close">;

function defaultBridge(target: Window): DesignPreviewBridge {
  return new DesignFrameBridge(target, 3000);
}

/**
 * Read-only preview of one frame version (a history checkpoint or the current
 * committed frame). It uses the same sandboxed runtime as the canvas, receives
 * no input, and only ever sends `render`, so it cannot edit a checkpoint.
 */
export function DesignCheckpointPreview({
  frame,
  label,
  width = 240,
  createBridge = defaultBridge,
}: {
  /** `null`: the frame did not exist in this version. */
  frame: DesignFrame | null;
  label: string;
  /** Maximum rendered width in CSS pixels; the frame is scaled down to fit. */
  width?: number;
  createBridge?: (target: Window) => DesignPreviewBridge;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [bridge, setBridge] = useState<DesignPreviewBridge | null>(null);
  const [state, setState] = useState<"rendering" | "ready" | "failed">("rendering");
  const html = useMemo(() => designBootstrap(createUuid()), []);

  useEffect(() => {
    if (!bridge) return;
    return () => bridge.close();
  }, [bridge]);

  const content = frame?.html;
  useEffect(() => {
    if (!bridge || content === undefined) return;
    let active = true;
    setState("rendering");
    bridge
      .ask({ op: "render", html: content })
      .then(() => active && setState("ready"))
      .catch(() => active && setState("failed"));
    return () => {
      active = false;
    };
  }, [bridge, content]);

  const scale = frame ? Math.min(1, width / Math.max(1, frame.width)) : 1;
  const boxWidth = frame ? Math.round(frame.width * scale) : width;
  const boxHeight = frame ? Math.round(frame.height * scale) : Math.round(width * 0.6);

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1" data-state={frame ? state : "absent"}>
      <figcaption className="truncate text-[11px] font-medium text-muted-foreground" title={label}>
        {label}
      </figcaption>
      <div
        className="relative max-w-full overflow-hidden rounded border border-divider bg-white"
        style={{ width: boxWidth, height: boxHeight }}
      >
        {frame ? (
          <>
            <iframe
              ref={iframe}
              title={`${label}: ${frame.name} (read-only)`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={html}
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-white"
              style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}
              onLoad={() => {
                const target = iframe.current?.contentWindow;
                if (target) setBridge(createBridge(target));
              }}
            />
            {state === "failed" && (
              <p className="absolute inset-0 grid place-content-center bg-background/80 px-2 text-center text-[11px] text-muted-foreground">
                This version could not be rendered
              </p>
            )}
          </>
        ) : (
          <p className="grid h-full place-content-center px-2 text-center text-[11px] text-muted-foreground">
            This frame did not exist in this version
          </p>
        )}
      </div>
    </figure>
  );
}
