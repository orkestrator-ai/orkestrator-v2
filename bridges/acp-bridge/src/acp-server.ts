import { createServer, type ServerResponse } from "node:http";
import {
  PARENT_PID_ENV,
  parseParentPid,
  startParentWatchdog,
} from "@orkestrator/protocol/parent-watchdog";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { watchClientDisconnect } from "./acp-client-disconnect.js";
import { CredentialError } from "./acp-credentials.js";
import { applyOriginPolicy, acceptsGzip, json, RESPONSE_ACCEPTS_GZIP, route } from "./acp-http.js";
import {
  HttpError,
  PARENT_WATCHDOG_INTERVAL_MS,
  cursorToolReplayProcesses,
  hostname,
  port,
  provider,
  setShuttingDown,
  sessions,
} from "./acp-context.js";
import { flushStreamingPersist } from "./acp-persist-writer.js";
import { restorePersistedState } from "./acp-persistence.js";
import { cancelCursorToolMetadataReconcile } from "./acp-tools.js";

await restorePersistedState();

export const server = createServer((request, response) => {
  (response as ServerResponse & { [RESPONSE_ACCEPTS_GZIP]?: boolean })[RESPONSE_ACCEPTS_GZIP] =
    acceptsGzip(request.headers["accept-encoding"]);
  if (!applyOriginPolicy(request, response)) return;
  const controller = new AbortController();
  const stopWatchingClient = watchClientDisconnect(request, response, () => controller.abort());
  void route(request, response, controller.signal)
    .catch((error: unknown) => {
      // `kind` separates a missing agent login from a bad bridge token, which
      // is also a 401; the backend shows the former's message as written.
      if (error instanceof CredentialError) {
        json(response, 401, { error: error.message, kind: "authentication-required" });
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(stopWatchingClient);
});

server.listen(port, hostname, () =>
  console.log(`ACP bridge (${provider}) listening on ${hostname}:${port}`),
);

let shutdownPromise: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  setShuttingDown(true);
  shutdownPromise = (async () => {
    for (const state of sessions.values()) {
      for (const approval of Array.from(state.approvals.values())) approval.respond();
      cancelCursorToolMetadataReconcile(state);
    }
    await Promise.allSettled([
      ...[...sessions.values()].map((state) => state.child?.close()),
      ...[...cursorToolReplayProcesses].map((child) => child.close()),
    ]);
    await flushStreamingPersist();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  })();
  return shutdownPromise;
}

// A dropped promise must not take this bridge — and every session it is
// serving — down with it.
installFatalRejectionGuard({ label: "[acp-bridge]" });

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
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
