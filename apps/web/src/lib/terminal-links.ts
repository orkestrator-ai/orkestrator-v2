export const TERMINAL_BROWSER_TAB_REQUEST_EVENT = "orkestrator:terminal-browser-tab-request";

export interface TerminalBrowserTabRequest {
  environmentId: string;
  sourceTabId: string;
  url: string;
}

type LinkMouseModifiers = Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">;

export type TerminalLinkTarget = "none" | "external" | "browser-tab";

export function getTerminalLinkTarget(event: LinkMouseModifiers): TerminalLinkTarget {
  if (!event.metaKey && !event.ctrlKey) {
    return "none";
  }
  return event.shiftKey ? "browser-tab" : "external";
}

export function requestTerminalBrowserTab(request: TerminalBrowserTabRequest): void {
  window.dispatchEvent(
    new CustomEvent<TerminalBrowserTabRequest>(TERMINAL_BROWSER_TAB_REQUEST_EVENT, {
      detail: request,
    }),
  );
}

interface TerminalLinkActivatorOptions {
  environmentId: string;
  sourceTabId: string;
  openExternal: (url: string) => Promise<void>;
}

/**
 * Builds the click handler shared by xterm's plain-URL addon and its OSC 8
 * `linkHandler` option. xterm's built-in OSC 8 handler falls back to
 * `confirm()` + `window.open()`, which never launches a browser in Electron.
 */
export function createTerminalLinkActivator({
  environmentId,
  sourceTabId,
  openExternal,
}: TerminalLinkActivatorOptions): (event: MouseEvent, uri: string) => void {
  return (event, uri) => {
    const target = getTerminalLinkTarget(event);
    if (target === "browser-tab") {
      requestTerminalBrowserTab({ environmentId, sourceTabId, url: uri });
      return;
    }
    if (target === "external") {
      void openExternal(uri).catch((err) => {
        console.error("[terminal-links] Failed to open URL:", err);
      });
    }
  };
}

export function listenForTerminalBrowserTabRequests(
  listener: (request: TerminalBrowserTabRequest) => void,
): () => void {
  const handleRequest = (event: Event) => {
    listener((event as CustomEvent<TerminalBrowserTabRequest>).detail);
  };

  window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, handleRequest);
  return () => {
    window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, handleRequest);
  };
}
