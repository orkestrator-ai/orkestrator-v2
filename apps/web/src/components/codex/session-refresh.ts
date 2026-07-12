export const CODEX_SESSION_STALE_AFTER_MS = 1500;

export interface CodexSessionRefreshController {
  markActivity: (timestamp?: number) => void;
  shouldRefresh: (timestamp?: number) => boolean;
  beginRequest: () => number;
  shouldApplyRequest: (requestId: number) => boolean;
}

export function createCodexSessionRefreshController(
  staleAfterMs = CODEX_SESSION_STALE_AFTER_MS,
): CodexSessionRefreshController {
  let lastActivityAt = 0;
  let latestRequestId = 0;

  return {
    markActivity(timestamp = Date.now()) {
      lastActivityAt = timestamp;
    },
    shouldRefresh(timestamp = Date.now()) {
      return timestamp - lastActivityAt >= staleAfterMs;
    },
    beginRequest() {
      latestRequestId += 1;
      return latestRequestId;
    },
    shouldApplyRequest(requestId: number) {
      return requestId === latestRequestId;
    },
  };
}
