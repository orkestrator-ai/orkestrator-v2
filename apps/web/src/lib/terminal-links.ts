export const TERMINAL_BROWSER_TAB_REQUEST_EVENT =
  "orkestrator:terminal-browser-tab-request";

export interface TerminalBrowserTabRequest {
  environmentId: string;
  sourceTabId: string;
  url: string;
}

type LinkMouseModifiers = Pick<
  MouseEvent,
  "ctrlKey" | "metaKey" | "shiftKey"
>;

export type TerminalLinkTarget = "none" | "external" | "browser-tab";

export function getTerminalLinkTarget(
  event: LinkMouseModifiers,
): TerminalLinkTarget {
  if (!event.metaKey && !event.ctrlKey) {
    return "none";
  }
  return event.shiftKey ? "browser-tab" : "external";
}

export function requestTerminalBrowserTab(
  request: TerminalBrowserTabRequest,
): void {
  window.dispatchEvent(
    new CustomEvent<TerminalBrowserTabRequest>(
      TERMINAL_BROWSER_TAB_REQUEST_EVENT,
      { detail: request },
    ),
  );
}

export function listenForTerminalBrowserTabRequests(
  listener: (request: TerminalBrowserTabRequest) => void,
): () => void {
  const handleRequest = (event: Event) => {
    listener(
      (event as CustomEvent<TerminalBrowserTabRequest>).detail,
    );
  };

  window.addEventListener(
    TERMINAL_BROWSER_TAB_REQUEST_EVENT,
    handleRequest,
  );
  return () => {
    window.removeEventListener(
      TERMINAL_BROWSER_TAB_REQUEST_EVENT,
      handleRequest,
    );
  };
}
