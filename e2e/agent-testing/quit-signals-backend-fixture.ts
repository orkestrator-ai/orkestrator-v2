import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireDesktopBackendOwnership } from "../../apps/backend/src/desktop-backend-ownership";

const scratch = process.cwd();
const dataDir = path.join(scratch, "profile");
if (process.argv.includes("--replacement")) {
  const pending = setTimeout(
    () => writeFileSync(path.join(scratch, "replacement-waiting"), ""),
    250,
  );
  await acquireDesktopBackendOwnership(dataDir);
  clearTimeout(pending);
  writeFileSync(path.join(scratch, "replacement-acquired"), "");
} else {
  await acquireDesktopBackendOwnership(dataDir);
  // Keep the old owner alive until the test releases the drain. Its watchdog
  // also handles an interrupted test after the Electron parent has exited.
  process.on("SIGTERM", () => writeFileSync(path.join(scratch, "backend-draining"), ""));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const authFile = path.join(scratch, "backend-auth");
  writeFileSync(authFile, JSON.stringify({ token: "quit-test-fixture-token" }));
  console.log(
    JSON.stringify({
      type: "orkestrator-backend-ready",
      url: server.url.href,
      authFile,
      bindAddress: "127.0.0.1",
      port: server.port,
    }),
  );
  const deadline = performance.now() + 15_000;
  while (!existsSync(path.join(scratch, "release-backend")) && performance.now() < deadline) {
    await Bun.sleep(50);
  }
  server.stop(true);
}
