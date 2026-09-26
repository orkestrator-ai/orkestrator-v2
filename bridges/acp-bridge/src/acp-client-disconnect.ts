/**
 * Noticing that the HTTP client behind an in-flight request has gone away.
 *
 * A renderer that navigates away, a backend request timeout or a proxy that
 * drops its upstream must reach a read in progress — a create waiting on a
 * hung agent `initialize` is the expensive case — but a turn already accepted
 * is never cancelled by this: closing a view is not the user asking the agent
 * to stop. The route decides what the signal cancels.
 *
 * Event-driven only. The bridge used to poll every in-flight request's socket
 * every 50 ms as well; on the pinned Bun runtime `response` "close" and socket
 * "close" fire for every disconnect shape the real-socket tests exercise
 * (full close, reset, half-close, partial body, proxy teardown, a stream that
 * had started writing, keep-alive reuse), at or before the moment the poll
 * would have seen it. See `docs/improvements/recurring-processes/plan/
 * 10-bridge-and-transport-lifecycle.md` for the evidence.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Call `onDisconnect` at most once if the client disconnects before the
 * response has ended. Returns a stop function that removes every listener;
 * call it when the route settles, on success and on failure alike, so a
 * keep-alive socket shared by later requests does not accumulate listeners.
 */
export function watchClientDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
  onDisconnect: () => void,
): () => void {
  const socket = request.socket;
  let watching = true;
  const disconnected = () => {
    if (!watching || response.writableEnded) return;
    watching = false;
    onDisconnect();
  };
  const stop = () => {
    watching = false;
    request.off("aborted", disconnected);
    response.off("close", disconnected);
    socket?.off("end", disconnected);
    socket?.off("close", disconnected);
  };

  // An incomplete request body.
  request.once("aborted", disconnected);
  // Any disconnect while the handler is still working, including one after
  // the response has started streaming.
  response.once("close", disconnected);
  // A half-close. Bun reports it through "close" instead; Node, whose HTTP
  // sockets allow half-open, reports it here first.
  socket?.once("end", disconnected);
  socket?.once("close", disconnected);
  // A socket that closed before this handler ran has already emitted its
  // events, so no listener registered now would ever hear about it.
  if (!socket || socket.destroyed) disconnected();
  return stop;
}
