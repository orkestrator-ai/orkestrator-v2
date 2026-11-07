import { armPullRequestFallback } from "./pull-request-load-fallback";
import {
  DEFAULT_TERMINAL_LINK_TARGET,
  resolveTerminalLinkDefaultTarget,
  type TerminalLinkDefaultTarget,
} from "@orkestrator/protocol/terminal-link-target";
import { parseGitHubPullRequestLink } from "@orkestrator/protocol/github-pull-requests";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { openPullRequestInApp, type PullRequestOpener } from "@/lib/pull-request-opener";
import { configStore } from "@/stores/configStore";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("terminal");

export const TERMINAL_BROWSER_TAB_REQUEST_EVENT = "orkestrator:terminal-browser-tab-request";

export interface TerminalBrowserTabRequest {
  environmentId: string;
  sourceTabId: string;
  url: string;
  /** Who printed the link. Agent links resolve as `agent-link` intents. Defaults to terminal. */
  origin?: "terminal" | "agent";
}

const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i;

/** A link to a loopback address, which a preview tab interprets in its source environment. */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_URL.test(url.trim());
}

type LinkMouseModifiers = Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">;

export type TerminalLinkTarget = "none" | "external" | "browser-tab";

/** A modifier click opens the default target; adding Shift opens the other one. */
export function getTerminalLinkTarget(
  event: LinkMouseModifiers,
  defaultTarget: TerminalLinkDefaultTarget = DEFAULT_TERMINAL_LINK_TARGET,
): TerminalLinkTarget {
  if (!event.metaKey && !event.ctrlKey) {
    return "none";
  }
  if (!event.shiftKey) {
    return defaultTarget;
  }
  return defaultTarget === "external" ? "browser-tab" : "external";
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
  /** Where a GitHub pull request link opens; defaults to the right-hand PR pane. */
  openPullRequest?: PullRequestOpener;
  /**
   * The terminal's node scope, resolved on each click: its settings choose the
   * default target and its files panel hosts a pull request. The app's command
   * scope when omitted.
   */
  scope?: () => NodeScope;
}

/**
 * Builds the click handler shared by xterm's plain-URL addon and its OSC 8
 * `linkHandler` option. xterm's built-in OSC 8 handler falls back to
 * `confirm()` + `window.open()`, which never launches a browser in Electron.
 * The default target is read on each click because a terminal outlives any one
 * value of the setting.
 *
 * A GitHub pull request link opened with the default gesture shows in the
 * right-hand PR pane instead, leaving the terminal in view; adding Shift
 * opens it externally, and so does a pull request the pane cannot host.
 */
export function createTerminalLinkActivator({
  environmentId,
  sourceTabId,
  openExternal,
  openPullRequest,
  scope: resolveScope = appCommandScope,
}: TerminalLinkActivatorOptions): (event: MouseEvent, uri: string) => void {
  return (event, uri) => {
    if (event.button !== 0) {
      return;
    }
    const scope = resolveScope();
    const target = getTerminalLinkTarget(
      event,
      resolveTerminalLinkDefaultTarget(
        scope.store(configStore).getState().config.global.terminalLinkDefaultTarget,
      ),
    );
    if (target === "none") {
      return;
    }
    const pullRequest = event.shiftKey ? null : parseGitHubPullRequestLink(uri);
    const opened =
      pullRequest &&
      (openPullRequest
        ? openPullRequest(pullRequest, pullRequest.view)
        : openPullRequestInApp(pullRequest, pullRequest.view, scope));
    if (pullRequest && opened) {
      armPullRequestFallback(pullRequest, uri);
      return;
    }
    if (target === "browser-tab" && isLoopbackUrl(uri)) {
      requestTerminalBrowserTab({ environmentId, sourceTabId, url: uri });
      return;
    }
    void openExternal(uri).catch((err) => {
      log.error("link.open-failed", { environmentId, error: formatLogError(err) });
    });
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
