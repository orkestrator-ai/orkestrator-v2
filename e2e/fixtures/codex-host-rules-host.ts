import { createCodexHostFixture } from "./codex-host-rules";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
installFatalRejectionGuard({ label: "[codex-host-fixture]" });
const fixture = await createCodexHostFixture();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/raise") fixture.raise();
    if (route === "/remove") fixture.remove();
    if (route === "/remember") {
      const { id, choice } = await request.json();
      return Response.json(await fixture.remember(id, choice));
    }
    return Response.json({
      snapshot: await fixture.snapshot(),
      rules: fixture.rules(),
      wireResponses: fixture.wireResponses,
    });
  },
});
process.on("SIGTERM", () => {
  server.stop(true);
  fixture.close();
  process.exit(0);
});
// The production modules this host loads log to the same stdout, so the spec
// waits for this marker rather than reading the first line as the address.
console.log(`CODEX_HOST_RULES_FIXTURE_READY:${server.port}`);
