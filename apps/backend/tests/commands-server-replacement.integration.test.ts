import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createEnvironment,
  createTempDir,
  existsSync,
  fs,
  path,
  withFakeDocker,
} = await createCommandFixtures();

// Claude's stop/replacement lives in commands-containers; Codex's lives in
// commands-registry-servers. Exercise both with the real HTTP health predicate.
for (const provider of ["claude", "codex"] as const) {
  test(`${provider} replaces a legacy bridge when the stop leaves an HTML responder`, async () => {
    const stateDir = await createTempDir(`ork-${provider}-html-replacement-`);
    const stoppedFile = path.join(stateDir, "stopped");
    const launchedFile = path.join(stateDir, "launched");
    let htmlProbes = 0;
    let replacementProbes = 0;
    const server = createServer((_request, response) => {
      const launched = existsSync(launchedFile);
      const html = existsSync(stoppedFile) && !launched;
      if (html) htmlProbes += 1;
      if (launched) replacementProbes += 1;
      response.writeHead(200, { "content-type": html ? "text/html" : "application/json" });
      response.end(html ? "<!doctype html><html></html>" : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const hostPort = (server.address() as AddressInfo).port;
    const environment = createEnvironment({
      id: `env-${provider}-html`,
      containerId: `container-${provider}-html`,
      environmentType: "containerized",
      status: "running",
    });
    const { context } = createContext(environment);
    const previous = {
      FAKE_HTML_HOST_PORT: process.env.FAKE_HTML_HOST_PORT,
      FAKE_HTML_STOPPED_FILE: process.env.FAKE_HTML_STOPPED_FILE,
      FAKE_HTML_LAUNCHED_FILE: process.env.FAKE_HTML_LAUNCHED_FILE,
    };
    process.env.FAKE_HTML_HOST_PORT = String(hostPort);
    process.env.FAKE_HTML_STOPPED_FILE = stoppedFile;
    process.env.FAKE_HTML_LAUNCHED_FILE = launchedFile;
    // No processes are signalled: the fake Docker records stop/start as files.
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_HTML_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/${provider}-bridge-token"*) printf 'legacy'; exit 0 ;;
      *"pkill -f"*) : > "$FAKE_HTML_STOPPED_FILE"; exit 0 ;;
    esac
    if [ "$2" = "-d" ]; then
      test -f "$FAKE_HTML_STOPPED_FILE" || exit 9
      : > "$FAKE_HTML_LAUNCHED_FILE"
    fi
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = await createCommandRegistry().get(`start_${provider}_server`)!(
          { containerId: environment.containerId },
          context,
        );
        expect(result).toMatchObject({
          hostPort,
          wasRunning: false,
          authToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        });
        // The stop wait and start's reuse check both encounter HTML. Neither
        // may mistake it for the old bridge still running or a reusable bridge.
        expect(htmlProbes).toBe(2);
        expect(replacementProbes).toBeGreaterThan(0);
        const execLog = await fs.readFile(logs.exec, "utf8");
        const stop = `pkill -f '[${provider[0]}]${provider.slice(1)}-bridge/dist/index.js'`;
        expect(execLog).toContain(stop);
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
        expect(execLog.indexOf(stop)).toBeLessThan(execLog.indexOf("exec -d "));
        expect(execLog).toContain(`${provider.toUpperCase()}_BRIDGE_TOKEN=`);
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}
