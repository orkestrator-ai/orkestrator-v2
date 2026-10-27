/** Runs the real bridge routes over loopback, with an owned-child crash control. */
import { app, __testing } from "../index.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Restart harness timed out");
    await Bun.sleep(10);
  }
}

async function main(): Promise<void> {
  const runtime = __testing.runtimeForTesting();
  await until(() => runtime.getHealth().state === "ready");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/__restart") return app.fetch(request);
      if (
        request.method !== "POST" ||
        request.headers.get("Authorization") !== `Bearer ${process.env.CODEX_BRIDGE_TOKEN}`
      ) {
        return new Response(null, { status: 403 });
      }
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !runtime.getStatus(sessionId)) return new Response(null, { status: 404 });
      const generation = runtime.getHealth().generation;
      // Only this disposable bridge's own app-server child is ever signalled.
      process.kill(runtime.getHealth().pid!, "SIGKILL");
      await until(() => runtime.getHealth().state === "restarting");
      // Recovery is demand-driven. Inventory starts the replacement process
      // without dispatching a turn or clearing the interruption notice.
      await runtime.listMcpServers(sessionId).catch(() => undefined);
      await until(
        () =>
          runtime.getHealth().generation > generation &&
          runtime.getStatus(sessionId)?.status === "error",
      );
      return Response.json({ generation: runtime.getHealth().generation });
    },
  });
  process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await __testing.stopSelectedEngineForTesting();
  process.exit(1);
});
