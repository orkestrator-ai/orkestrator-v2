import { chmod, cp, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ON_DEMAND_BRIDGES, RUNTIME_SUBDIRECTORY } from "./bridges.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const manifest = (await Bun.file(path.join(packageRoot, "package.json")).json()) as {
  version?: string;
};
if (typeof manifest.version !== "string") {
  throw new Error("CLI package version is missing");
}

const READY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 10_000;

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }
}

/**
 * Waits for the process to exit, escalating to SIGKILL if it ignores SIGTERM.
 * Without the escalation a wedged backend would hang this script forever.
 */
async function stop(child: Bun.Subprocess): Promise<number | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode ?? undefined;
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
  try {
    return await child.exited;
  } finally {
    clearTimeout(escalation);
  }
}

// Tracked outside the try so the cleanup below can never delete the installed
// package and its data directory out from under a still-running child.
let backend: Bun.Subprocess | undefined;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-packed-smoke-"));
try {
  await run(
    [process.execPath, "pm", "pack", "--cwd", packageRoot, "--destination", temporaryRoot],
    packageRoot,
  );
  await run([process.execPath, "init", "-y"], temporaryRoot);
  await run(
    [process.execPath, "add", path.join(temporaryRoot, `orkestrator-${manifest.version}.tgz`)],
    temporaryRoot,
  );

  // The bridges are spawned lazily by an environment, long after startup, so a
  // dependency the backend never touches would otherwise fail in front of a
  // user. Check resolution from the installed layout — the hoisting the registry
  // install produces is what a workspace checkout cannot reproduce.
  const installedRoot = path.join(temporaryRoot, "node_modules", "orkestrator");
  for (const [artifact, specifier] of [
    ["dist/main.js", "sharp"],
    ["resources/claude-bridge/dist/index.js", "@anthropic-ai/claude-agent-sdk"],
  ] as const) {
    // Resolve from the real path, as Bun does when it loads the module: with
    // the isolated linker `node_modules/orkestrator` is a symlink into
    // `node_modules/.bun/`, and the package's dependencies sit beside its real
    // directory there, not beside the link.
    const directory = await realpath(path.join(installedRoot, path.dirname(artifact)));
    try {
      console.log(`resolved ${specifier} -> ${Bun.resolveSync(specifier, directory)}`);
    } catch (error) {
      throw new Error(
        `Installed package cannot resolve ${specifier} from ${directory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // On-demand bridges install their SDKs on first use. Do what the backend does
  // (`apps/backend/src/core/bridge-runtime-install.ts`) from the installed
  // package's own inputs, so a lockfile the registry no longer satisfies or a
  // patch that no longer applies fails here rather than on a user's machine.
  for (const bridge of ON_DEMAND_BRIDGES) {
    const source = path.join(installedRoot, "resources", bridge.name);
    const target = path.join(temporaryRoot, "bridge-runtimes", bridge.name);
    await cp(path.join(source, RUNTIME_SUBDIRECTORY), target, { recursive: true });
    await mkdir(path.join(target, "dist"), { recursive: true });
    await cp(path.join(source, "dist", "index.js"), path.join(target, "dist", "index.js"));
    await run(
      [
        process.execPath,
        "install",
        "--frozen-lockfile",
        "--production",
        "--linker=hoisted",
        "--ignore-scripts",
        "--no-progress",
        "--no-summary",
      ],
      target,
    );
    for (const specifier of bridge.external) {
      console.log(
        `${bridge.name}: resolved ${specifier} -> ${Bun.resolveSync(specifier, path.join(target, "dist"))}`,
      );
    }
  }

  const dataDir = path.join(temporaryRoot, "data");
  const executable = path.join(temporaryRoot, "node_modules", ".bin", "orkestrator");
  const clientEnv = {
    ...process.env,
    ORKESTRATOR_CLI_CONFIG_DIR: path.join(temporaryRoot, "cli-config"),
    ORKESTRATOR_CONTROL_MCP_DISABLED: "1",
  };
  const client = async (
    argv: string[],
    expected = 0,
    env: Record<string, string | undefined> = clientEnv,
  ): Promise<string> => {
    const run = Bun.spawn([executable, ...argv], {
      cwd: temporaryRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== expected) {
      throw new Error(
        `orkestrator ${argv.slice(0, 3).join(" ")} exited ${code}: ${stderr.slice(-2000)}`,
      );
    }
    return stdout;
  };

  // Help, version and client errors run without any backend and never create
  // its data directory.
  await client(["--help"]);
  await client(["help", "environment", "start"]);
  if (!(await client(["version"])).includes(manifest.version)) {
    throw new Error("version did not report the package version");
  }
  await client(["--json", "project", "list"], 4);
  if (await Bun.file(path.join(dataDir, "config.json")).exists()) {
    throw new Error("A client command created backend state");
  }
  console.log("client help/version/errors ran without a backend");

  // `child` keeps the piped-stdio type the spawn options imply; `backend` is the
  // widened handle the cleanup below reaches for.
  const child = Bun.spawn(
    [
      executable,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--worktree-dir",
      path.join(temporaryRoot, "worktrees"),
    ],
    {
      cwd: temporaryRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ORKESTRATOR_CONTROL_MCP_DISABLED: "1" },
    },
  );
  backend = child;

  // Killing the child is what unblocks the read below: `reader.read()` never
  // resolves on its own if the backend stalls without writing or exiting.
  const timeout = setTimeout(() => child.kill("SIGTERM"), READY_TIMEOUT_MS);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let ready = false;
  try {
    while (!ready) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          if (JSON.parse(line).type === "orkestrator-backend-ready") ready = true;
        } catch {
          // Human-readable startup logs precede the readiness contract.
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  if (!ready) {
    await stop(child);
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Installed package did not become ready: ${stderr}`);
  }

  // Drain stdout so the service never blocks on a full pipe.
  const drain = child.stdout.getReader();
  void (async () => {
    try {
      for (;;) if ((await drain.read()).done) break;
    } catch {
      // Exited.
    }
  })();

  // Without ORKESTRATOR_CLI_CONFIG_DIR the client keeps its configuration in
  // the platform's per-user directory (macOS: Application Support), private
  // to the user, and refuses a configuration other users could rewrite. A
  // disposable HOME keeps the operator's own configuration out of reach.
  const home = path.join(temporaryRoot, "home");
  const platformEnv: Record<string, string | undefined> = {
    ...clientEnv,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  delete platformEnv.ORKESTRATOR_CLI_CONFIG_DIR;
  const platformConfigDir =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "orkestrator-cli")
      : path.join(home, ".config", "orkestrator-cli");
  const platformConfig = path.join(platformConfigDir, "connections.json");
  await client(
    ["connection", "add", "platform", "--data-dir", dataDir, "--default"],
    0,
    platformEnv,
  );
  const modeOf = async (target: string) => (await stat(target)).mode & 0o777;
  if ((await modeOf(platformConfigDir)) !== 0o700 || (await modeOf(platformConfig)) !== 0o600) {
    throw new Error(
      `${platformConfigDir} is not private (directory ${(await modeOf(platformConfigDir)).toString(8)}, file ${(await modeOf(platformConfig)).toString(8)})`,
    );
  }
  await client(["--json", "project", "list"], 0, platformEnv);
  await chmod(platformConfig, 0o664);
  const refused = JSON.parse(await client(["--json", "project", "list"], 4, platformEnv)) as {
    ok: boolean;
    error?: { code?: string };
  };
  if (refused.ok || refused.error?.code !== "connection-not-configured") {
    throw new Error("A group-writable client configuration was not refused");
  }
  await chmod(platformConfig, 0o600);
  await client(["--json", "project", "list"], 0, platformEnv);
  console.log(`platform config directory ${platformConfigDir} is private and enforced`);

  // The installed client drives the installed service end to end.
  await client(["connection", "add", "smoke", "--data-dir", dataDir, "--default"]);
  const listed = (await client(["--json", "project", "list"])).trim().split("\n");
  if (listed.length !== 1 || JSON.parse(listed[0]!).ok !== true) {
    throw new Error("project list did not print exactly one successful JSON envelope");
  }
  const fixture = path.join(temporaryRoot, "fixture");
  const origin = path.join(temporaryRoot, "fixture-origin.git");
  const git = (args: string[], cwd?: string) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Smoke",
        GIT_AUTHOR_EMAIL: "smoke@example.invalid",
        GIT_COMMITTER_NAME: "Smoke",
        GIT_COMMITTER_EMAIL: "smoke@example.invalid",
      },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  };
  git(["init", "--bare", "-b", "main", origin]);
  git(["init", "-b", "main", fixture]);
  await Bun.write(path.join(fixture, "README.md"), "# smoke\n");
  git(["add", "."], fixture);
  git(["commit", "-m", "smoke"], fixture);
  git(["remote", "add", "origin", origin], fixture);
  git(["push", "-u", "origin", "main"], fixture);
  const projectId = (await client(["project", "add", "--path", fixture, "--output", "id"])).trim();
  const environmentId = (
    await client([
      "environment",
      "create",
      "--project",
      projectId,
      "--type",
      "local",
      "--output",
      "id",
    ])
  ).trim();
  await client([
    "environment",
    "start",
    environmentId,
    "--wait",
    "ready",
    "--timeout",
    "2m",
    "--json",
  ]);
  await client([
    "environment",
    "delete",
    environmentId,
    "--wait",
    "deleted",
    "--timeout",
    "2m",
    "--json",
  ]);
  await client(["project", "remove", projectId, "--json"]);
  const services = Bun.spawnSync(["ps", "-eo", "args"])
    .stdout.toString()
    .split("\n")
    .filter((line) => line.includes(`--data-dir ${dataDir}`));
  if (services.length !== 1) {
    throw new Error(`Expected exactly one backend for the data dir, found ${services.length}`);
  }
  console.log("installed client drove a fixture lifecycle against the installed service");

  const exitCode = await stop(child);
  if (exitCode !== 0) {
    throw new Error(`Installed package exited with ${exitCode}`);
  }
  if (await Bun.file(path.join(dataDir, "backend-instance.json")).exists()) {
    throw new Error("The instance descriptor survived a graceful shutdown");
  }
  console.log("Installed tarball started and stopped cleanly");
} finally {
  if (backend) await stop(backend);
  await rm(temporaryRoot, { recursive: true, force: true });
}
