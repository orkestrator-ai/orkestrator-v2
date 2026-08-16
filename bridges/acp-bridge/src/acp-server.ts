import { createServer, type ServerResponse } from "node:http";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import { applyOriginPolicy, acceptsGzip, json, RESPONSE_ACCEPTS_GZIP, route } from "./acp-http.js";
import {
  HttpError,
  PARENT_WATCHDOG_INTERVAL_MS,
  cursorToolReplayProcesses,
  hostname,
  port,
  persistenceTail,
  provider,
  setShuttingDown,
  sessions,
} from "./acp-context.js";
import { restorePersistedState } from "./acp-persistence.js";
import { cancelCursorToolMetadataReconcile } from "./acp-tools.js";

await restorePersistedState();

export const server = createServer((request, response) => {
  (response as ServerResponse & { [RESPONSE_ACCEPTS_GZIP]?: boolean })[
    RESPONSE_ACCEPTS_GZIP
  ] = acceptsGzip(request.headers["accept-encoding"]);
  if (!applyOriginPolicy(request, response)) return;
  const controller = new AbortController();
  const abortDisconnectedClient = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abortDisconnectedClient);
  request.socket.once("end", abortDisconnectedClient);
  request.socket.once("close", abortDisconnectedClient);
  response.once("close", abortDisconnectedClient);
  const disconnectPoll = setInterval(() => {
    if (request.socket.destroyed || !request.socket.writable) abortDisconnectedClient();
  }, 50);
  disconnectPoll.unref();
  void route(request, response, controller.signal)
    .catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      clearInterval(disconnectPoll);
      request.off("aborted", abortDisconnectedClient);
      request.socket.off("end", abortDisconnectedClient);
      request.socket.off("close", abortDisconnectedClient);
      response.off("close", abortDisconnectedClient);
    });
});

server.listen(port, hostname, () => console.log(`ACP bridge (${provider}) listening on ${hostname}:${port}`));

let shutdownPromise: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  setShuttingDown(true);
  shutdownPromise = (async () => {
    for (const state of sessions.values()) {
      for (const approval of [...state.approvals.values()]) approval.respond();
      cancelCursorToolMetadataReconcile(state);
    }
    await Promise.allSettled([
      ...[...sessions.values()].map((state) => state.child?.close()),
      ...[...cursorToolReplayProcesses].map((child) => child.close()),
    ]);
    await persistenceTail.catch(() => undefined);
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  })();
  return shutdownPromise;
}

export const parentPid = parseParentPid(process.env[PARENT_PID_ENV]);
if (parentPid !== null) {
  startParentWatchdog({
    parentPid,
    pollIntervalMs: PARENT_WATCHDOG_INTERVAL_MS,
    onParentExit: () => {
      void shutdown().finally(() => process.exit(0));
    },
  });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0), () => process.exit(1));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
