// Standalone backend: owning, restarting and refusing Tailscale Serve listeners.
import { describe, expect, jest, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  root,
  createTemporaryDirectory,
  startBackend,
  processes,
  registerStandaloneCleanup,
} from "./standalone-test-support";
import { waitForStandaloneBackendReady } from "./standalone-ready";

// A case can include backend startup, a real child-process tree, and graceful
// shutdown. The helper deadlines remain narrower so failures retain a specific
// diagnostic instead of Bun killing the fixture at its default five seconds.
jest.setTimeout(30_000);
registerStandaloneCleanup();

describe("standalone backend service", () => {
  test("can own a Tailscale Serve listener and publish its HTTPS URL", async () => {
    const testDir = await createTemporaryDirectory("orkestrator-tailscale-test-");
    const executable = path.join(testDir, "tailscale");
    const logFile = path.join(testDir, "calls.log");
    // Tracks the root mount separately from the user's own `/api` handler, so a
    // scoped teardown cannot masquerade as a full-listener removal. `/api` also
    // keeps the TCP entry alive after shutdown, which is the state a restart has
    // to tolerate.
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
case " $* " in
  *" --set-path=/ off "*) rm -f "$TAILSCALE_TEST_LOG.root"; exit 0 ;;
  *" off "*) rm -f "$TAILSCALE_TEST_LOG.root" "$TAILSCALE_TEST_LOG.api"; exit 0 ;;
esac
if [ "$*" = "serve status --json" ]; then
  handlers='"/api":{"Proxy":"http://127.0.0.1:9000"}'
  if [ -f "$TAILSCALE_TEST_LOG.root" ]; then
    port=$(cat "$TAILSCALE_TEST_LOG.port")
    handlers=$(printf '"/":{"Proxy":"http://127.0.0.1:%s"},%s' "$port" "$handlers")
  fi
  printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{%s}}}}\\n' "$handlers"
  exit 0
fi
for arg in "$@"; do last_arg="$arg"; done
printf '%s' "\${last_arg##*:}" > "$TAILSCALE_TEST_LOG.port"
touch "$TAILSCALE_TEST_LOG.root"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`,
    );
    await chmod(executable, 0o755);

    const { child, readyMessage } = await startBackend(
      ["--tailscale-serve", "--tailscale-bin", executable],
      { TAILSCALE_TEST_LOG: logFile },
    );

    expect(readyMessage.browserUrl).toBe("https://workstation.example.ts.net/");
    expect(readyMessage.bindAddress).toBe("127.0.0.1");
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);

    const calls = await readFile(logFile, "utf8");
    expect(calls).toContain("serve --bg --yes --https=443 http://127.0.0.1:");
    expect(calls).toContain("serve --yes --https=443 --set-path=/ off");
    // The whole-listener form would have taken `/api` with it.
    expect(calls).not.toContain("serve --yes --https=443 off\n");

    // A second backend must be able to claim the port again even though `/api`
    // is still holding it open.
    const restarted = await startBackend(["--tailscale-serve", "--tailscale-bin", executable], {
      TAILSCALE_TEST_LOG: logFile,
    });
    expect(restarted.readyMessage.browserUrl).toBe("https://workstation.example.ts.net/");
    restarted.child.kill("SIGTERM");
    await expect(restarted.child.exited).resolves.toBe(0);
  }, 60_000);

  test("exits without a leftover listener when environment-managed Serve setup fails", async () => {
    const testDir = await createTemporaryDirectory("orkestrator-tailscale-fail-");
    const executable = path.join(testDir, "tailscale");
    const logFile = path.join(testDir, "calls.log");
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
if [ "$*" = "serve status --json" ]; then
  printf '{}\\n'
  exit 0
fi
echo 'Tailscale HTTPS is not enabled for this tailnet' >&2
exit 1
`,
    );
    await chmod(executable, 0o755);

    const dataDir = await createTemporaryDirectory("orkestrator-standalone-test-");
    const rendererRoot = path.join(dataDir, "renderer");
    await mkdir(rendererRoot);
    await writeFile(
      path.join(rendererRoot, "index.html"),
      "<!doctype html><title>Orkestrator</title>",
    );

    const child = Bun.spawn(
      [
        process.execPath,
        path.join(root, "apps/backend/dist/main.js"),
        "--port",
        "0",
        "--data-dir",
        dataDir,
        "--app-root",
        root,
        "--resource-root",
        root,
        "--renderer-root",
        rendererRoot,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ORKESTRATOR_TAILSCALE_SERVE: "1",
          ORKESTRATOR_TAILSCALE_BIN: executable,
          TAILSCALE_TEST_LOG: logFile,
        },
      },
    );
    processes.push(child);

    await expect(child.exited).resolves.not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "Unable to configure Tailscale Serve: Tailscale HTTPS is not enabled for this tailnet",
    );
    const calls = await readFile(logFile, "utf8");
    expect(calls).toContain("serve status --json");
    expect(calls).toContain("serve --bg --yes --https=443 http://127.0.0.1:");
    // Configuration never succeeded, so shutdown must not remove anyone's listener.
    expect(calls).not.toContain("off");
  });

  test("serves an IPv6 loopback listener through Tailscale Serve without the allow flag", async () => {
    const testDir = await createTemporaryDirectory("orkestrator-tailscale-test-");
    const executable = path.join(testDir, "tailscale");
    const logFile = path.join(testDir, "calls.log");
    // Reports back whatever root proxy target it was last given, so shutdown
    // only recognises the root as its own if startup proxied to [::1].
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
case " $* " in
  *" off "*) rm -f "$TAILSCALE_TEST_LOG.root"; exit 0 ;;
esac
if [ "$*" = "serve status --json" ]; then
  if [ -f "$TAILSCALE_TEST_LOG.root" ]; then
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "$(cat "$TAILSCALE_TEST_LOG.root")"
  else
    printf '{}\\n'
  fi
  exit 0
fi
for arg in "$@"; do last_arg="$arg"; done
printf '%s' "$last_arg" > "$TAILSCALE_TEST_LOG.root"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`,
    );
    await chmod(executable, 0o755);
    const dataDir = await createTemporaryDirectory("orkestrator-standalone-test-");
    const rendererRoot = path.join(dataDir, "renderer");
    await mkdir(rendererRoot);
    await writeFile(
      path.join(rendererRoot, "index.html"),
      "<!doctype html><title>Orkestrator</title>",
    );

    const child = Bun.spawn(
      [
        process.execPath,
        path.join(root, "apps/backend/dist/main.js"),
        "--tailscale-serve",
        "--tailscale-bin",
        executable,
        "--host",
        "::1",
        "--port",
        "0",
        "--data-dir",
        dataDir,
        "--app-root",
        root,
        "--resource-root",
        root,
        "--renderer-root",
        rendererRoot,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TAILSCALE_TEST_LOG: logFile },
      },
    );
    processes.push(child);

    const { readyMessage } = await waitForStandaloneBackendReady(child);
    expect(readyMessage.browserUrl).toBe("https://workstation.example.ts.net/");
    expect(readyMessage.bindAddress).toBe("::1");
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);

    const calls = await readFile(logFile, "utf8");
    expect(calls).toMatch(/serve --bg --yes --https=443 http:\/\/\[::1\]:\d+\n/);
    expect(calls).toContain("serve --yes --https=443 --set-path=/ off");
  }, 60_000);

  test("refuses Tailscale Serve on a non-loopback, non-Tailscale host", async () => {
    const dataDir = await createTemporaryDirectory("orkestrator-standalone-test-");
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(root, "apps/backend/dist/main.js"),
        "--tailscale-serve",
        "--host",
        "0.0.0.0",
        "--data-dir",
        dataDir,
      ],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    processes.push(child);

    await expect(child.exited).resolves.not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "Refusing to bind gateway to non-Tailscale address: 0.0.0.0",
    );
  });
});
