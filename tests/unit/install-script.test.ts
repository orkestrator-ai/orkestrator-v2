import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const INSTALL_SCRIPT = path.join(root, "apps/web-public/public/install.sh");
const INSTALL_URL = "https://orkestrator.dev/install.sh";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type InstallerRun = { exitCode: number; stdout: string; stderr: string };

type InstallerScenario = {
  /** What the stubbed `uname -s` reports. */
  platform?: string;
  /** Launchers already resolvable through PATH. */
  onPath?: string[];
  /** Launchers the Bun installer is treated as having left in BUN_INSTALL/bin. */
  installed?: string[];
  /** Omit BUN_INSTALL so the script has to fall back to ~/.bun. */
  useHomeDefault?: boolean;
  args?: string[];
};

async function writeStub(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Absolute shebang, so the stub runs even though PATH holds only the sandbox.
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

/**
 * Runs the real installer against a sandboxed PATH. Every external command it
 * reaches for is stubbed, so the assertions cover our dispatch logic rather than
 * Bun's installer or a developer's machine.
 */
async function runInstaller(scenario: InstallerScenario = {}): Promise<InstallerRun> {
  const {
    platform = "Darwin",
    onPath = [],
    installed = [],
    useHomeDefault = false,
    args = [],
  } = scenario;

  const sandbox = await mkdtemp(path.join(os.tmpdir(), "orkestrator-install-sh-"));
  temporaryDirectories.push(sandbox);
  const pathDirectory = path.join(sandbox, "path");
  const home = path.join(sandbox, "home");
  const bunInstall = useHomeDefault ? path.join(home, ".bun") : path.join(sandbox, "bun");

  await writeStub(path.join(pathDirectory, "uname"), `printf '${platform}\\n'`);
  // The script pipes the downloaded installer into `bash`, which it resolves
  // through PATH like any other command.
  await writeStub(path.join(pathDirectory, "bash"), 'exec /bin/bash "$@"');
  // Stands in for bun.com's installer. It succeeds and emits a no-op script; the
  // executables a real run would leave behind are staged through `installed`.
  await writeStub(path.join(pathDirectory, "curl"), "printf ':\\n'");

  for (const name of onPath) {
    await writeStub(path.join(pathDirectory, name), `printf 'path-${name} %s\\n' "$*"`);
  }
  for (const name of installed) {
    await writeStub(path.join(bunInstall, "bin", name), `printf 'installed-${name} %s\\n' "$*"`);
  }
  await mkdir(path.join(bunInstall, "bin"), { recursive: true });
  await mkdir(home, { recursive: true });

  const child = Bun.spawn(["/bin/bash", INSTALL_SCRIPT, ...args], {
    cwd: sandbox,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: pathDirectory,
      HOME: home,
      ...(useHomeDefault ? {} : { BUN_INSTALL: bunInstall }),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const PUBLISHED_ARGS = [
  "--tailscale-serve",
  "--allowed-origins",
  "https://orkestrator.dev,https://www.orkestrator.dev",
];

describe("web-public install.sh", () => {
  test("is served at the URL both READMEs tell users to pipe into bash", async () => {
    // Vite copies apps/web-public/public/ to the site root verbatim, and Vercel
    // checks the filesystem before applying its SPA rewrite, so the script has to
    // live here for the documented one-liner to fetch a script rather than HTML.
    await expect(Bun.file(INSTALL_SCRIPT).exists()).resolves.toBe(true);
    for (const readme of ["README.md", "packages/cli/README.md"]) {
      expect(await readFile(path.join(root, readme), "utf8")).toContain(INSTALL_URL);
    }
  });

  test("refuses to run on an unsupported platform", async () => {
    const result = await runInstaller({ platform: "MINGW64_NT-10.0", onPath: ["bunx"] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("macOS and Linux only");
    // The launcher must not run before the platform gate has passed.
    expect(result.stdout).toBe("");
  });

  for (const platform of ["Darwin", "Linux"]) {
    test(`runs on supported platform ${platform}`, async () => {
      const result = await runInstaller({ platform, onPath: ["bunx"] });
      expect({ platform, exitCode: result.exitCode }).toEqual({ platform, exitCode: 0 });
    });
  }

  test("launches the published CLI through bunx and passes arguments through", async () => {
    const result = await runInstaller({ onPath: ["bunx", "bun"], args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`path-bunx orkestrator ${PUBLISHED_ARGS.join(" ")}`);
    // Bun was never downloaded, because a launcher was already available.
    expect(result.stderr).not.toContain("installing it now");
  });

  test("launches with no arguments", async () => {
    // `"$@"` under `set -u` must not trip on an empty argument list.
    const result = await runInstaller({ onPath: ["bunx"] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("path-bunx orkestrator");
  });

  test("falls back to `bun x` when only bun is on PATH", async () => {
    const result = await runInstaller({ onPath: ["bun"], args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`path-bun x orkestrator ${PUBLISHED_ARGS.join(" ")}`);
  });

  test("installs Bun and launches it from BUN_INSTALL when no launcher is on PATH", async () => {
    const result = await runInstaller({ installed: ["bunx", "bun"], args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Bun was not found");
    expect(result.stdout).toBe(`installed-bunx orkestrator ${PUBLISHED_ARGS.join(" ")}`);
  });

  test("uses the installed bun when the install leaves no bunx", async () => {
    const result = await runInstaller({ installed: ["bun"], args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`installed-bun x orkestrator ${PUBLISHED_ARGS.join(" ")}`);
  });

  test("defaults BUN_INSTALL to ~/.bun", async () => {
    const result = await runInstaller({ installed: ["bunx"], useHomeDefault: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("installed-bunx orkestrator");
  });

  test("fails loudly when the install leaves no executable behind", async () => {
    const result = await runInstaller({ args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("its executable was not found in");
    expect(result.stdout).toBe("");
  });
});
