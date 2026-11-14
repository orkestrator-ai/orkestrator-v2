// Standalone backend: packaged Sharp runtime, web app and command serving, and the agent-test credential handoff.
import { describe, expect, jest, test } from "bun:test";
import { semver } from "bun";
import { cp, mkdir, readFile, realpath, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironment } from "../src/core/storage";
import { agentTestHostCursorCredentialPath } from "../src/core/agent-test-cursor-credential";
import {
  root,
  createTemporaryDirectory,
  startBackend,
  invokeBackend,
  probeSharpResolution,
  registerStandaloneCleanup,
} from "./standalone-test-support";

// A case can include backend startup, a real child-process tree, and graceful
// shutdown. The helper deadlines remain narrower so failures retain a specific
// diagnostic instead of Bun killing the fixture at its default five seconds.
jest.setTimeout(30_000);
registerStandaloneCleanup();

describe("standalone backend service", () => {
  test("loads Sharp from the packaged runtime closure", async () => {
    const packageRoot = await createTemporaryDirectory("orkestrator-packaged-backend-");
    const packagedBackend = path.join(packageRoot, "backend");
    const packagedNodeModules = path.join(packagedBackend, "node_modules");
    await mkdir(packagedBackend, { recursive: true });
    await cp(path.join(root, "apps/backend/dist/main.js"), path.join(packagedBackend, "main.js"));
    await cp(path.join(root, "apps/backend/dist/node_modules"), packagedNodeModules, {
      recursive: true,
      dereference: true,
    });

    const resolution = await probeSharpResolution(packagedBackend);
    expect(resolution.exitCode, resolution.stderr).toBe(0);
    const resolvedSharp = fileURLToPath(resolution.stdout.trim());
    const relativeSharpPath = path.relative(
      await realpath(path.join(packagedNodeModules, "sharp")),
      resolvedSharp,
    );
    expect(relativeSharpPath === ".." || relativeSharpPath.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeSharpPath)).toBe(false);
    const packagedSharp = JSON.parse(
      await readFile(path.join(packagedNodeModules, "sharp/package.json"), "utf8"),
    ) as { version: string };
    const backendManifest = JSON.parse(
      await readFile(path.join(root, "apps/backend/package.json"), "utf8"),
    ) as { dependencies: { sharp: string } };
    expect(semver.satisfies(packagedSharp.version, backendManifest.dependencies.sharp)).toBe(true);

    const { url, token } = await startBackend([], { NODE_PATH: "" }, undefined, {
      bunArgs: ["--no-install"],
      entry: path.join(packagedBackend, "main.js"),
      cwd: packageRoot,
    });
    const project = (await invokeBackend(url, token, "add_project", {
      gitUrl: "https://example.invalid/image-runtime.git",
    })) as { id: string };
    const task = (await invokeBackend(url, token, "add_kanban_task", {
      projectId: project.id,
      title: "Packaged image runtime",
      description: "",
    })) as { id: string };
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADklEQVR4AWL6////fwAAAAD//w7I1cwAAAAGSURBVAMACgUD/9k79a8AAAAASUVORK5CYII=";

    const updated = (await invokeBackend(url, token, "add_kanban_image", {
      taskId: task.id,
      filename: "reference.png",
      data: onePixelPng,
    })) as { images: Array<{ filename: string }> };
    expect(updated.images).toEqual([expect.objectContaining({ filename: "reference.png" })]);
  });

  test("fails closed when the packaged Sharp closure is missing", async () => {
    const packageRoot = await createTemporaryDirectory("orkestrator-missing-sharp-");
    const packagedBackend = path.join(packageRoot, "backend");
    await mkdir(packagedBackend, { recursive: true });

    const resolution = await probeSharpResolution(packagedBackend);
    expect(resolution.exitCode).not.toBe(0);
    expect(resolution.stdout).toBe("");
    expect(resolution.stderr.toLowerCase()).toContain("sharp");
  });

  test("serves the web app and invokes backend commands without Electron", async () => {
    const { url, token, readyMessage } = await startBackend();
    expect(readyMessage).not.toHaveProperty("token");
    expect(JSON.stringify(readyMessage)).not.toContain(token);
    const authorization = { authorization: `Bearer ${token}` };
    const invokeResponse = await Bun.fetch(new URL("/__orkestrator/invoke", url), {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ command: "greet", args: { name: "standalone" } }),
    });
    expect(invokeResponse.status).toBe(200);
    expect(await invokeResponse.json()).toEqual({
      result: "Hello, standalone! You've been greeted from the Orkestrator backend!",
    });

    const webResponse = await Bun.fetch(url, { headers: authorization });
    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get("content-type")).toContain("text/html");
  });

  test("agent-test startup loads the Cursor snapshot and launches Pi with only host auth and its default model", async () => {
    const args = ["--runtime-flavor", "agent-test", "--credential-source", "cursor,pi"];
    const isolatedHome = await createTemporaryDirectory("orkestrator-standalone-worktree-");
    const hostPi = path.join(isolatedHome, "host-pi");
    await mkdir(hostPi);
    await writeFile(path.join(hostPi, "auth.json"), "{}");
    await writeFile(
      path.join(hostPi, "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.5" }),
    );
    const started = await startBackend(
      args,
      {
        HOME: isolatedHome,
        CURSOR_API_KEY: "",
        PI_CODING_AGENT_DIR: "",
        ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR: hostPi,
      },
      async ({ dataDir }) => {
        const snapshot = agentTestHostCursorCredentialPath(dataDir);
        await mkdir(path.dirname(snapshot), { recursive: true });
        await writeFile(
          snapshot,
          JSON.stringify({ apiKey: "startup-fixture-key", apiKeyExpiresAtMs: Date.now() + 60_000 }),
        );
        const worktree = path.join(dataDir, "worktree");
        await mkdir(worktree);
        const environment = createEnvironment("project-1");
        await writeFile(
          path.join(dataDir, "environments.json"),
          JSON.stringify([
            {
              ...environment,
              id: "credential-handoff",
              environmentType: "local",
              worktreePath: worktree,
              status: "running",
            },
          ]),
        );
        const appRoot = path.join(isolatedHome, "app");
        const bin = path.join(appRoot, "bin");
        await mkdir(bin, { recursive: true });
        await symlink(process.execPath, path.join(bin, "bun"));
        for (const bridge of ["cursor-bridge", "pi-bridge"]) {
          const dist = path.join(appRoot, "bridges", bridge, "dist");
          await mkdir(dist, { recursive: true });
          // Exercise actual launch environments without exposing credentials in
          // test output or contacting any provider.
          await writeFile(
            path.join(dist, "index.js"),
            `
          Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() {
            return Response.json({
              snapshotSelected: process.env.CURSOR_API_KEY === "startup-fixture-key",
              authFile: process.env.PI_BRIDGE_AUTH_FILE ?? null,
              defaultModel: process.env.PI_BRIDGE_DEFAULT_MODEL ?? null,
              agentDir: process.env.PI_AGENT_DIR ?? null,
              codingAgentDir: process.env.PI_CODING_AGENT_DIR || null,
              home: process.env.HOME,
            });
          }});
        `,
          );
        }
      },
      {
        entry: path.join(root, "apps/backend/src/main.ts"),
        appRoot: path.join(isolatedHome, "app"),
      },
    );
    try {
      await expect(
        invokeBackend(started.url, started.token, "cursor_sdk_login_status", {}),
      ).resolves.toMatchObject({
        auth: { authenticated: true, source: "host-snapshot" },
      });
      const cursor = (await invokeBackend(
        started.url,
        started.token,
        "start_local_cursor_server_cmd",
        { environmentId: "credential-handoff" },
      )) as { port: number };
      const cursorEnv = await (
        await Bun.fetch(`http://127.0.0.1:${cursor.port}/global/health`)
      ).json();
      expect(cursorEnv.snapshotSelected).toBe(true);
      const pi = (await invokeBackend(started.url, started.token, "start_local_pi_server_cmd", {
        environmentId: "credential-handoff",
      })) as { port: number };
      const piEnv = await (await Bun.fetch(`http://127.0.0.1:${pi.port}/global/health`)).json();
      expect(piEnv).toMatchObject({
        authFile: path.join(hostPi, "auth.json"),
        defaultModel: "openai-codex/gpt-5.5",
        agentDir: null,
        codingAgentDir: null,
        home: isolatedHome,
      });
    } finally {
      started.child.kill("SIGTERM");
      await started.child.exited;
    }
  });
});
