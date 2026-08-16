import { readFile } from "node:fs/promises";

export const DEFAULT_BACKEND_READY_TIMEOUT_MS = 20_000;
/** A backend wedged in startup need not act on SIGTERM. Escalate rather than wait forever. */
export const DEFAULT_BACKEND_KILL_GRACE_MS = 2_000;
/**
 * stderr is diagnostic only. Draining it unbounded would hang in exactly the
 * case the diagnostic exists for, so a partial message beats no message.
 */
export const DEFAULT_STDERR_DIAGNOSTIC_TIMEOUT_MS = 1_000;

export interface StandaloneStartupChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

export interface WaitForStandaloneReadyOptions {
  readyTimeoutMs?: number;
  killGraceMs?: number;
  stderrDiagnosticTimeoutMs?: number;
  readAuthFile?: (path: string) => Promise<string>;
}

export interface StandaloneReadyResult {
  url: string;
  token: string;
  readyMessage: Record<string, unknown>;
}

/**
 * Wait until a spawned standalone backend prints its ready line, then load the
 * auth token. The stdout read is raced against `readyTimeoutMs` so a child that
 * never closes stdout still fails with a named diagnostic. SIGTERM/SIGKILL run
 * only on that timeout path; accepting the ready line clears the deadline
 * before the auth-file read so a slow disk cannot kill a backend that already
 * came up.
 */
export const waitForStandaloneBackendReady = async (
  child: StandaloneStartupChild,
  options: WaitForStandaloneReadyOptions = {},
): Promise<StandaloneReadyResult> => {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_BACKEND_READY_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_BACKEND_KILL_GRACE_MS;
  const stderrDiagnosticTimeoutMs =
    options.stderrDiagnosticTimeoutMs ?? DEFAULT_STDERR_DIAGNOSTIC_TIMEOUT_MS;
  const readAuthFile = options.readAuthFile ?? ((authPath) => readFile(authPath, "utf8"));

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const readStderr = async (): Promise<string> =>
    await Promise.race([
      new Response(child.stderr).text().catch(() => ""),
      Bun.sleep(stderrDiagnosticTimeoutMs).then(() => "<stderr not drained in time>"),
    ]);
  const EXPIRED = Symbol("startup-expired");
  let expire!: () => void;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    expire = () => resolve(EXPIRED);
  });
  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | undefined;
  const expiry = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killEscalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    expire();
  }, readyTimeoutMs);
  try {
    while (true) {
      const pendingRead = reader.read();
      const next = await Promise.race([pendingRead, expired]);
      if (next === EXPIRED) {
        // Releasing the lock below rejects this abandoned read. Swallow it so
        // it cannot surface as an unhandled rejection in another test.
        void pendingRead.catch(() => undefined);
        throw new Error(
          `Timed out waiting for standalone backend after ${readyTimeoutMs}ms: ${await readStderr()}`,
        );
      }
      const { done, value } = next;
      if (done) {
        throw new Error(`Backend exited during startup: ${await readStderr()}`);
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Human-readable gateway logs precede the machine-readable ready line.
          continue;
        }
        if (
          message.type !== "orkestrator-backend-ready"
          || typeof message.url !== "string"
          || typeof message.authFile !== "string"
        ) {
          continue;
        }
        // The ready line is accepted. Drop the deadline before reading the
        // auth file so that await cannot overlap the kill timer.
        clearTimeout(expiry);
        const auth = JSON.parse(await readAuthFile(message.authFile)) as { token?: unknown };
        if (typeof auth.token !== "string") {
          throw new Error("Backend auth file is missing its token");
        }
        return { url: message.url, token: auth.token, readyMessage: message };
      }
    }
  } finally {
    clearTimeout(expiry);
    if (!timedOut && killEscalation !== undefined) {
      clearTimeout(killEscalation);
    }
    try {
      reader.releaseLock();
    } catch {
      // A read is still outstanding on the timeout path. The child has already
      // been signalled, so the abandoned stream dies with the process.
    }
  }
};
