/**
 * Drives the bridge's HTTP surface in a fresh process and prints the result as
 * JSON on stdout.
 *
 * A separate process is required, not merely convenient: `index.ts` builds its
 * engine and spawns the app-server child at module load, so a test that has
 * already imported it cannot get a fresh one. Spawning is the only way to exercise
 * the real startup path end to end.
 *
 * Invoked by `app-server-http.test.ts`; not part of the shipped bundle.
 */
import { app } from "../index.js";

interface StepResult {
  step: string;
  status: number;
  body: unknown;
}

async function main(): Promise<void> {
  const results: StepResult[] = [];
  const record = async (step: string, response: Response) => {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the raw text for the assertion to report.
    }
    results.push({ step, status: response.status, body });
    return body as Record<string, unknown>;
  };

  // Wait for the engine to finish its handshake; index.ts starts it in the
  // background so the HTTP server is up even if the child is slow.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = (await (await app.request("/global/health")).json()) as {
      appServer?: { state?: string };
      engine?: string;
    };
    if (health.engine !== "app-server" || health.appServer?.state === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await record("health", await app.request("/global/health"));
  await record("models", await app.request("/global/models"));

  const created = await record(
    "create",
    await app.request("/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "build" }),
    }),
  );
  const sessionId = String(created.sessionId ?? "");

  await record(
    "prompt",
    await app.request(`/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello from the harness", requestId: "req-http-1" }),
    }),
  );

  // Let the scripted turn's notifications land.
  await new Promise((resolve) => setTimeout(resolve, 250));

  await record("messages", await app.request(`/session/${sessionId}/messages`));
  await record("status", await app.request(`/session/${sessionId}/status`));

  // A duplicate request id must not run a second turn.
  await record(
    "duplicate-prompt",
    await app.request(`/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello from the harness", requestId: "req-http-1" }),
    }),
  );

  await record("delete", await app.request(`/session/${sessionId}`, { method: "DELETE" }));

  process.stdout.write(`${JSON.stringify({ engine: "app-server", results })}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
