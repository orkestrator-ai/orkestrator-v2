import type { Subprocess } from "bun";
import { retryOnAddressInUse } from "@orkestrator/protocol/testing/ports";
import { OpenCode2Client } from "./client.js";

/**
 * Starts a 2.x `opencode serve` that a live test launches by hand, on a port
 * chosen afresh for every attempt. `opencode serve` must be given its port,
 * so the gap between choosing and binding cannot be closed; a port another
 * process takes in that gap ("Is port N in use?" on the server's stderr)
 * costs a retry instead of the test (flake 9974). Any other failure to become
 * ready is thrown at once, with the end of the server's stderr.
 *
 * `spawn` must send the server's stderr to `stderrPath`. Every process it
 * returns is handed to `onSpawn` first, so the caller's cleanup owns it.
 */
export async function startOpenCode2OnFreePort(options: {
  spawn: (port: number) => Subprocess;
  stderrPath: string;
  password: string;
  directory: string;
  onSpawn: (server: Subprocess) => void;
}): Promise<{ server: Subprocess; port: number; client: OpenCode2Client }> {
  return retryOnAddressInUse(async () => {
    // Released before the server binds it; a loss is retried with a fresh one.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const server = options.spawn(port);
    options.onSpawn(server);
    const client = new OpenCode2Client({
      baseUrl: `http://127.0.0.1:${port}`,
      password: options.password,
      directory: options.directory,
    });
    // A server that exited (its port taken since it was chosen) never becomes ready.
    for (let attempt = 0; attempt < 150 && server.exitCode === null; attempt++) {
      const ready = await client.info().then(
        (info) => info.version.startsWith("2."),
        () => false,
      );
      if (ready) return { server, port, client };
      await Bun.sleep(200);
    }
    if (server.exitCode === null) server.kill("SIGKILL");
    await server.exited;
    const stderr = await Bun.file(options.stderrPath)
      .text()
      .catch(() => "");
    // The port-in-use line leads, so `retryOnAddressInUse` sees it however long the trace is.
    const inUse = /^.*(?:Is port \d+ in use\?|EADDRINUSE).*$/m.exec(stderr)?.[0]?.trim();
    throw new Error(
      `opencode serve was not ready on port ${port} (exit ${server.exitCode})` +
        `${inUse ? `: ${inUse}` : ""}; stderr ends: ${stderr.slice(-400)}`,
    );
  });
}
