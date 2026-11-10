import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("desktop.webrequest");

/**
 * Every response Electron's answering webRequest events take (`onBeforeRequest`,
 * `onBeforeSendHeaders`, `onHeadersReceived`) accepts `cancel`, which is the
 * last-resort answer when a listener's own fail-closed response throws too.
 */
type CancellableResponse = { cancel?: boolean };

/** What a listener decides: its response, now or later. */
export type WebRequestDecision<Details, Response> = (
  details: Details,
) => Response | PromiseLike<Response>;

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * A webRequest listener that always answers. Electron's callback is called
 * exactly once, whatever `decide` does:
 *
 * - it returns a response (or a promise of one): that response;
 * - it throws, or its promise rejects: `failClosed(details)`;
 * - `failClosed` throws as well: `{ cancel: true }`.
 *
 * A listener that throws before calling back leaves its request unanswered and
 * gives main an uncaught exception; a session outlives its window, so a
 * listener can run after whatever it looks up for that window is gone (flake
 * 0622; docs/architecture/renderer-security.md, "webRequest listeners").
 * Every `webRequest.on*` call in main goes through this or
 * {@link observing}; the `raw-webrequest-listener` source guard enforces it.
 *
 * `failClosed` is the answer that is safe for this listener when its decision
 * is unknown: cancel for an admission policy, the request without its
 * credential for a header hook. `listener` is a static name for the log; the
 * error itself is never logged, because a decision's error may hold a URL or a
 * credential.
 */
export function answering<Details, Response extends CancellableResponse>(
  listener: string,
  decide: WebRequestDecision<Details, Response>,
  failClosed: (details: Details) => Response,
): (details: Details, callback: (response: Response) => void) => void {
  return (details, callback) => {
    let answered = false;
    const answer = (response: Response): void => {
      if (answered) return;
      answered = true;
      try {
        callback(response);
      } catch (error) {
        log.throttled("warn", "callback.failed", { scope: listener, error });
      }
    };
    const fallBack = (error: unknown): void => {
      log.throttled("warn", "listener.failed-closed", { scope: listener, error });
      let response: Response;
      try {
        response = failClosed(details);
      } catch {
        response = { cancel: true } as Response;
      }
      answer(response);
    };
    const succeed = (response: Response): void => {
      log.recovered("listener.failed-closed", listener);
      answer(response);
    };
    try {
      const decided = decide(details);
      // Both reading a then accessor and invoking it can throw.
      if (isPromiseLike<Response>(decided)) {
        decided.then(succeed, fallBack);
      } else {
        succeed(decided);
      }
    } catch (error) {
      fallBack(error);
    }
  };
}

/**
 * A webRequest listener Electron gives no callback (`onBeforeRedirect`,
 * `onCompleted`, ...). Nothing waits on it, but a throw is still an uncaught
 * exception in main, so it is caught here and `onFailure` runs instead: the
 * fail-closed action for this observer, itself best effort.
 */
export function observing<Details>(
  listener: string,
  observe: (details: Details) => void,
  onFailure?: (details: Details) => void,
): (details: Details) => void {
  return (details) => {
    try {
      observe(details);
      log.recovered("observer.failed", listener);
      return;
    } catch (error) {
      log.throttled("warn", "observer.failed", { scope: listener, error });
    }
    try {
      onFailure?.(details);
    } catch {
      // Best effort: the observer already failed and was logged.
    }
  };
}
