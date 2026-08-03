import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "./opencode-client";

interface OpenCodeLiveCompatibilityResult {
  cliVersion: string;
  healthVersion: string;
  sdkVersion: string;
  sessionCount: number;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) throw new Error("Could not allocate a loopback port");
  return port;
}

async function waitForHealth(
  baseUrl: string,
  processHandle: ReturnType<typeof Bun.spawn>,
): Promise<{ healthy: boolean; version: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy (${processHandle.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`);
      if (response.ok) {
        return (await response.json()) as { healthy: boolean; version: string };
      }
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error("OpenCode did not become healthy", { cause: lastError });
}

async function runOpenCodeLiveCompatibility(): Promise<OpenCodeLiveCompatibilityResult> {
  const webManifest = JSON.parse(
    await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const expectedVersion = webManifest.dependencies?.["@opencode-ai/sdk"];
  if (!expectedVersion?.match(/^\d+\.\d+\.\d+$/)) {
    throw new Error("apps/web must exactly pin @opencode-ai/sdk");
  }

  const cliPath = process.env.OPENCODE_CLI_PATH?.trim() || "opencode";
  const versionProbe = Bun.spawn([cliPath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [versionOutput, versionError, versionExitCode] = await Promise.all([
    new Response(versionProbe.stdout).text(),
    new Response(versionProbe.stderr).text(),
    versionProbe.exited,
  ]);
  if (versionExitCode !== 0) {
    throw new Error(`Could not execute ${cliPath}: ${versionError.trim()}`);
  }
  const cliVersion = versionOutput.trim().split(/\s+/).at(-1) || "";
  if (cliVersion !== expectedVersion) {
    throw new Error(
      `${cliPath} reports ${cliVersion || "an unknown version"}, but `
      + `@opencode-ai/sdk pins ${expectedVersion}`,
    );
  }

  const isolatedRoot = await mkdtemp(join(tmpdir(), "ork-opencode-compat-"));
  const configRoot = join(isolatedRoot, "config");
  const dataRoot = join(isolatedRoot, "data");
  const stateRoot = join(isolatedRoot, "state");
  const cacheRoot = join(isolatedRoot, "cache");
  await Promise.all(
    [configRoot, dataRoot, stateRoot, cacheRoot].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const port = await availableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(
    [cliPath, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: isolatedRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: dataRoot,
        XDG_STATE_HOME: stateRoot,
        XDG_CACHE_HOME: cacheRoot,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  try {
    const health = await waitForHealth(baseUrl, server);
    if (!health.healthy || health.version !== expectedVersion) {
      throw new Error(
        `OpenCode health reported ${JSON.stringify(health)}, expected version ${expectedVersion}`,
      );
    }

    const client = createClient(baseUrl, isolatedRoot);
    const sessions = await client.session.list();
    if (sessions.error) {
      throw new Error("OpenCode SDK session.list returned an error");
    }
    if (!Array.isArray(sessions.data)) {
      throw new Error("OpenCode SDK session.list did not return an array");
    }
    if (sessions.data.length !== 0) {
      throw new Error(`Isolated OpenCode server returned ${sessions.data.length} sessions`);
    }

    return {
      cliVersion,
      healthVersion: health.version,
      sdkVersion: expectedVersion,
      sessionCount: sessions.data.length,
    };
  } finally {
    if (server.exitCode === null) server.kill();
    await server.exited;
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runOpenCodeLiveCompatibility()));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
