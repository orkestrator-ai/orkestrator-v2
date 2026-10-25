import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Exercise the actual main.ts startup call and a real catalogue subprocess.
// Only the backend composition root is replaced, so no user data, Docker or
// provider credentials are needed. The probe uses production env construction.
test("startup removes the parent agent connection before the login shell and catalogue probe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-inherited-connection-"));
  const source = path.resolve(import.meta.dir, "../src");
  const shell = path.join(root, "login-shell");
  const shellCapture = path.join(root, "shell-presence");
  const probeCapture = path.join(root, "probe-presence.json");
  const preload = path.join(root, "startup-preload.ts");
  const bridge = path.join(root, "bridges", "codex-bridge", "dist");
  try {
    await mkdir(bridge, { recursive: true });
    await writeFile(
      shell,
      `#!/bin/sh
printf '%s' "\${ORKESTRATOR_AGENT_MCP_URL+x}\${ORKESTRATOR_AGENT_MCP_TOKEN+x}" > "$ORKESTRATOR_STARTUP_SHELL_CAPTURE"
printf '%s' "$PATH"
`,
    );
    await chmod(shell, 0o700);
    await writeFile(
      path.join(bridge, "index.js"),
      `
      await Bun.write(process.env.ORKESTRATOR_STARTUP_PROBE_CAPTURE, JSON.stringify({
        url: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_MCP_URL"),
        token: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_MCP_TOKEN"),
      }));
      Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
        if (new URL(request.url).pathname === "/global/health") return new Response("ok");
        return Response.json({ source: "app-server", models: [{ id: "fixture" }] });
      }});
    `,
    );
    await writeFile(
      preload,
      `
      import { mock } from "bun:test";
      import { refreshHostModelCatalog } from ${JSON.stringify(path.join(source, "core/host-model-catalog-refresh.ts"))};
      import { BackendRuntime } from ${JSON.stringify(path.join(source, "core/backend-runtime.ts"))};
      mock.module(${JSON.stringify(path.join(source, "core/index.ts"))}, () => ({
        OrkestratorBackend: class {
          async init() {
            await refreshHostModelCatalog({
              appRoot: ${JSON.stringify(root)}, resourceRoot: ${JSON.stringify(root)},
              storage: { getDataDir: () => ${JSON.stringify(root)}, loadConfig: async () => ({ global: {} }) },
              runtime: new BackendRuntime({ emit: () => undefined }),
            }, "codex");
            process.exit(0);
          }
        },
      }));
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        path.join(source, "main.ts"),
        "--data-dir",
        path.join(root, "data"),
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SHELL: shell,
          ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:9/mcp",
          ORKESTRATOR_AGENT_MCP_TOKEN: "test-decoy",
          ORKESTRATOR_STARTUP_SHELL_CAPTURE: shellCapture,
          ORKESTRATOR_STARTUP_PROBE_CAPTURE: probeCapture,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(await readFile(shellCapture, "utf8")).toBe("");
      expect(JSON.parse(await readFile(probeCapture, "utf8"))).toEqual({
        url: false,
        token: false,
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
