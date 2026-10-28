/**
 * Child for bounded-console.integration.test.ts: serves HTTP while logging
 * steadily, so the parent can stop reading stdout and probe whether this
 * process still answers. `bounded` installs the backend's bounded console;
 * `plain` keeps Bun's own console as the control.
 */
import { installBoundedConsole } from "../../src/bounded-console.js";

const mode = process.argv[2];
if (mode === "bounded") installBoundedConsole({ maxPendingBytes: 256 * 1024 });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
// stderr is never paused by the parent; it carries the port.
process.stderr.write(`PORT ${server.port}\n`);
const line = `LOG ${"x".repeat(200)}`;
setInterval(() => {
  for (let index = 0; index < 20; index += 1) console.log(line);
}, 10);
