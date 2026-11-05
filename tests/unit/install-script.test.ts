import { afterAll, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostUpdateChannelOfVersion } from "../../packages/protocol/src/host-maintenance.js";
import { pinnedRelease } from "../../scripts/pin-install-script.js";

const root = path.resolve(import.meta.dir, "../..");
const INSTALL_SCRIPT = path.join(root, "apps/web-public/public/install.sh");
const INSTALL_URL = "https://orkestrator.dev/install.sh";
const SCRIPT = await readFile(INSTALL_SCRIPT, "utf8");
const temporaryDirectories: string[] = [];
const PINNED = pinnedRelease(SCRIPT);
const PACKAGE = `orkestrator@${PINNED}`;
const PINNED_BUN = /^PINNED_BUN="([^"]+)"$/m.exec(SCRIPT)![1]!;
const BUN_RELEASES = `https://github.com/oven-sh/bun/releases/download/bun-v${PINNED_BUN}`;

// Every case launches the real shell script through a sandbox of executable
// shims. Aggregate process contention must not let Bun interrupt teardown and
// turn the child exit into the misleading signal-derived code 143.
jest.setTimeout(20_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type InstallerRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every `bun install` the script ran, one argument list per line. */
  installs: string[];
  /** Every URL the script downloaded. */
  downloads: string[];
  bunDirectory: string;
  /** What the script left in its temporary directory. */
  leftInTmp: string[];
};

type DownloadFixture = {
  /** The archive name the script is expected to ask for, e.g. `darwin-aarch64`. */
  target: string;
  /** Stamp the fixture archive's real hash for `target` into the script. */
  stampHash?: boolean;
  /** The version the downloaded bun reports. */
  version?: string;
  /** curl fails instead of downloading. */
  unreachable?: boolean;
};

type InstallerScenario = {
  /** What the stubbed `uname -s` reports. */
  platform?: string;
  /** What the stubbed `uname -m` reports. */
  machine?: string;
  /** What the stubbed macOS `sysctl` reports, by key. */
  sysctl?: Record<string, string>;
  /** A bun already resolvable through PATH. */
  bunOnPath?: boolean;
  /** A bun already in BUN_INSTALL/bin. */
  bunInstalled?: boolean;
  /** Omit BUN_INSTALL so the script has to fall back to ~/.bun. */
  useHomeDefault?: boolean;
  download?: DownloadFixture;
  /** Which SHA-256 tool the host has. */
  hasher?: "sha256sum" | "shasum";
  args?: string[];
  /** The caller's own choice of release. */
  installVersion?: string;
};

async function writeStub(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Absolute shebang, so the stub runs even though PATH holds only the sandbox.
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

function realTool(name: string): string {
  const found = Bun.which(name, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/bin/core_perl" });
  if (!found) throw new Error(`${name} is required to run the install.sh tests`);
  return found;
}

/** Stands in for Bun. `install` leaves a fetched package without a release runtime. */
function bunStub(label: string, version: string, installLog: string): string {
  return `case "$1" in
  --version) printf '%s\\n' '${version}' ;;
  install)
    printf '%s\\n' "$*" >> '${installLog}'
    mkdir -p node_modules/orkestrator && printf '{}\\n' > node_modules/orkestrator/package.json ;;
  x) shift; printf '${label} x %s\\n' "$*" ;;
  *) printf '${label} %s\\n' "$*" ;;
esac`;
}

/**
 * Runs the real installer against a sandboxed PATH. Every external command it
 * reaches for is stubbed or a known system tool, so the assertions cover our
 * dispatch logic rather than Bun's servers or a developer's machine.
 */
async function runInstaller(scenario: InstallerScenario = {}): Promise<InstallerRun> {
  const {
    platform = "Darwin",
    machine = "arm64",
    sysctl = {},
    bunOnPath = false,
    bunInstalled = false,
    useHomeDefault = false,
    download,
    hasher = "sha256sum",
    args = [],
    installVersion,
  } = scenario;

  const sandbox = await mkdtemp(path.join(os.tmpdir(), "orkestrator-install-sh-"));
  temporaryDirectories.push(sandbox);
  const pathDirectory = path.join(sandbox, "path");
  const home = path.join(sandbox, "home");
  const tmp = path.join(sandbox, "tmp");
  const bunInstall = useHomeDefault ? path.join(home, ".bun") : path.join(sandbox, "bun");
  const bunDirectory = path.join(bunInstall, "bin");
  const installLog = path.join(sandbox, "installs.log");
  const downloadLog = path.join(sandbox, "downloads.log");
  await mkdir(tmp, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(pathDirectory, { recursive: true });

  for (const tool of ["mktemp", "rm", "mkdir", "cp", "mv", "chmod", "ln", "sleep", hasher]) {
    await symlink(realTool(tool), path.join(pathDirectory, tool));
  }
  await writeStub(
    path.join(pathDirectory, "uname"),
    `case "$1" in -m) printf '${machine}\\n' ;; *) printf '${platform}\\n' ;; esac`,
  );
  await writeStub(
    path.join(pathDirectory, "sysctl"),
    [
      "shift",
      "status=1",
      'for key in "$@"; do',
      '  case "$key" in',
      ...Object.entries(sysctl).map(
        ([key, value]) => `    ${key}) printf '%s\\n' '${value}'; status=0 ;;`,
      ),
      "  esac",
      "done",
      "exit $status",
    ].join("\n"),
  );

  let script = SCRIPT;
  if (download) {
    const archiveBytes = `fixture bun archive for ${download.target}\n`;
    const archive = path.join(sandbox, "fixture.zip");
    await writeFile(archive, archiveBytes);
    const downloadedBun = path.join(sandbox, "downloaded-bun");
    await writeStub(
      downloadedBun,
      bunStub("downloaded-bun", download.version ?? PINNED_BUN, installLog),
    );
    await writeStub(
      path.join(pathDirectory, "curl"),
      download.unreachable
        ? `printf '%s\\n' "$*" >> '${downloadLog}'; exit 22`
        : [
            'out=""; url=""',
            "while [ $# -gt 0 ]; do",
            '  case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac',
            "  shift",
            "done",
            `printf '%s\\n' "$url" >> '${downloadLog}'`,
            `cp '${archive}' "$out"`,
          ].join("\n"),
    );
    // Unpacks the fixture as Bun's archive layout: bun-<target>/bun.
    await writeStub(
      path.join(pathDirectory, "unzip"),
      [
        'archive=""; dir=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in -d) dir="$2"; shift ;; -*) ;; *) archive="$1" ;; esac',
        "  shift",
        "done",
        'name="${archive##*/}"; name="${name%.zip}"',
        'mkdir -p "$dir/$name"',
        `cp '${downloadedBun}' "$dir/$name/bun"`,
      ].join("\n"),
    );
    if (download.stampHash) {
      const variable = `BUN_SHA256_${download.target.toUpperCase().replaceAll("-", "_")}`;
      const hash = createHash("sha256").update(archiveBytes).digest("hex");
      const stamped = script.replace(
        new RegExp(`^${variable}="[0-9a-f]{64}"$`, "m"),
        `${variable}="${hash}"`,
      );
      expect(stamped).not.toBe(script);
      script = stamped;
    }
  }
  const scriptFile = path.join(sandbox, "install.sh");
  await writeFile(scriptFile, script);

  if (bunOnPath) {
    await writeStub(path.join(pathDirectory, "bun"), bunStub("path-bun", PINNED_BUN, installLog));
  }
  if (bunInstalled) {
    await writeStub(
      path.join(bunDirectory, "bun"),
      bunStub("installed-bun", PINNED_BUN, installLog),
    );
  }

  const child = Bun.spawn(["/bin/bash", scriptFile, ...args], {
    cwd: sandbox,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: pathDirectory,
      HOME: home,
      TMPDIR: tmp,
      ...(useHomeDefault ? {} : { BUN_INSTALL: bunInstall }),
      ...(installVersion ? { ORKESTRATOR_INSTALL_VERSION: installVersion } : {}),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    installs: lines(installLog),
    downloads: lines(downloadLog),
    bunDirectory,
    leftInTmp: await readdir(tmp),
  };
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

  test("pins a Stable release, not a moving tag or a prerelease", async () => {
    expect(hostUpdateChannelOfVersion(PINNED)).toBe("stable");
    // The pin only moves after a release is published, so it trails the repository.
    const { version } = (await Bun.file(path.join(root, "package.json")).json()) as {
      version: string;
    };
    expect(Bun.semver.order(PINNED, version)).toBeLessThanOrEqual(0);
    // Every launch line goes through the pin.
    expect(SCRIPT).not.toMatch(/\borkestrator "\$@"/);
  });

  test("never pipes a downloaded script into a shell", () => {
    expect(SCRIPT).not.toContain("bun.com/install");
    expect(SCRIPT).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(SCRIPT).not.toContain("releases/latest");
    // `main` runs on the last line, so a truncated download runs nothing.
    expect(SCRIPT.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });

  test("a Beta or Unstable user can choose another release", async () => {
    const result = await runInstaller({
      bunOnPath: true,
      installVersion: "alpha",
      args: PUBLISHED_ARGS,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`path-bun x orkestrator@alpha ${PUBLISHED_ARGS.join(" ")}`);
  });

  test("refuses a release choice that is not a tag or a version", async () => {
    const result = await runInstaller({ bunOnPath: true, installVersion: 'x","evil":"1' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be an npm tag or a version");
    expect(result.installs).toEqual([]);
  });

  test("refuses to run on an unsupported platform", async () => {
    const result = await runInstaller({ platform: "MINGW64_NT-10.0", bunOnPath: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("macOS and Linux only");
    // Nothing runs before the platform gate has passed.
    expect(result.stdout).toBe("");
    expect(result.installs).toEqual([]);
  });

  for (const platform of ["Darwin", "Linux"]) {
    test(`runs on supported platform ${platform}`, async () => {
      const result = await runInstaller({ platform, machine: "aarch64", bunOnPath: true });
      expect({ platform, exitCode: result.exitCode }).toEqual({ platform, exitCode: 0 });
    });
  }

  test("fetches the package with scripts off in its own cache, then launches it", async () => {
    const result = await runInstaller({ bunOnPath: true, args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.installs).toHaveLength(1);
    const fetch = result.installs[0]!;
    expect(fetch).toContain("--ignore-scripts");
    expect(fetch).toContain("--production");
    expect(fetch).toMatch(/--cache-dir \S+\/orkestrator-install\.\w+\/fetch\/\.cache/);
    // This fixture publishes no release runtime, which is how a release from
    // before the lockfile looks: it runs through `bun x` as it always did.
    expect(result.stdout).toBe(`path-bun x ${PACKAGE} ${PUBLISHED_ARGS.join(" ")}`);
    // Bun was never downloaded, because one was already available.
    expect(result.downloads).toEqual([]);
    expect(result.stderr).not.toContain("installing Bun");
    // The fetch directory is gone before the CLI takes over.
    expect(result.leftInTmp).toEqual([]);
  });

  test("launches with no arguments", async () => {
    // `"$@"` under `set -u` must not trip on an empty argument list.
    const result = await runInstaller({ bunOnPath: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`path-bun x ${PACKAGE}`);
  });

  test("uses a Bun already in BUN_INSTALL when none is on PATH", async () => {
    const result = await runInstaller({ bunInstalled: true, args: PUBLISHED_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`installed-bun x ${PACKAGE} ${PUBLISHED_ARGS.join(" ")}`);
    expect(result.downloads).toEqual([]);
  });

  test("defaults BUN_INSTALL to ~/.bun", async () => {
    const result = await runInstaller({ bunInstalled: true, useHomeDefault: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`installed-bun x ${PACKAGE}`);
  });

  test("downloads the pinned Bun, checks it, and launches with it", async () => {
    const result = await runInstaller({
      download: { target: "darwin-aarch64", stampHash: true },
      args: PUBLISHED_ARGS,
    });

    expect(result.exitCode).toBe(0);
    expect(result.downloads).toEqual([`${BUN_RELEASES}/bun-darwin-aarch64.zip`]);
    expect(result.stderr).toContain(`installing Bun ${PINNED_BUN}`);
    expect(result.stdout).toBe(`downloaded-bun x ${PACKAGE} ${PUBLISHED_ARGS.join(" ")}`);
    expect((await lstat(path.join(result.bunDirectory, "bun"))).isFile()).toBe(true);
    expect(await readlink(path.join(result.bunDirectory, "bunx"))).toBe("bun");
    // Only the two launchers: no staged copy left beside them.
    expect((await readdir(result.bunDirectory)).sort()).toEqual(["bun", "bunx"]);
    expect(result.leftInTmp).toEqual([]);
  });

  test("defaults the Bun download to ~/.bun", async () => {
    const result = await runInstaller({
      download: { target: "darwin-aarch64", stampHash: true },
      useHomeDefault: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.bunDirectory).toContain(path.join("home", ".bun", "bin"));
    expect(existsSync(path.join(result.bunDirectory, "bun"))).toBe(true);
  });

  test("refuses a Bun archive whose SHA-256 is not the stated one", async () => {
    // The script's own hashes are Bun's real ones; this fixture is not that archive.
    const result = await runInstaller({
      download: { target: "darwin-aarch64" },
      args: PUBLISHED_ARGS,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match its stated SHA-256");
    expect(result.stdout).toBe("");
    expect(existsSync(path.join(result.bunDirectory, "bun"))).toBe(false);
    expect(result.installs).toEqual([]);
    expect(result.leftInTmp).toEqual([]);
  });

  test("refuses a Bun that reports another version", async () => {
    const result = await runInstaller({
      download: { target: "darwin-aarch64", stampHash: true, version: "1.0.0" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`reports version '1.0.0', not ${PINNED_BUN}`);
    expect(existsSync(result.bunDirectory) ? await readdir(result.bunDirectory) : []).toEqual([]);
    expect(result.installs).toEqual([]);
  });

  test("fails loudly when Bun cannot be downloaded", async () => {
    const result = await runInstaller({
      download: { target: "darwin-aarch64", unreachable: true },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Could not download ${BUN_RELEASES}/bun-darwin-aarch64.zip`);
    expect(result.stdout).toBe("");
  });

  test("refuses an architecture Bun publishes no build for", async () => {
    const result = await runInstaller({ platform: "Linux", machine: "riscv64" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Bun publishes no build for Linux riscv64");
    expect(result.downloads).toEqual([]);
  });

  test.skipIf(!Bun.which("shasum", { PATH: "/usr/bin:/bin:/usr/bin/core_perl" }))(
    "checks the download with shasum where sha256sum is missing",
    async () => {
      const result = await runInstaller({
        download: { target: "darwin-aarch64", stampHash: true },
        hasher: "shasum",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`downloaded-bun x ${PACKAGE}`);
    },
  );

  // The archive Bun's own installer would choose. Each case stamps the hash only
  // for the expected archive, so choosing another one fails the hash check too.
  const hostLinuxX64 = (() => {
    const musl = existsSync("/etc/alpine-release") ? "-musl" : "";
    const cpuinfo = existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf8") : "";
    return `linux-x64${musl}${cpuinfo.includes("avx2") ? "" : "-baseline"}`;
  })();
  const targets: Array<[string, InstallerScenario, string]> = [
    ["Apple Silicon", { platform: "Darwin", machine: "arm64" }, "darwin-aarch64"],
    [
      "Intel Mac with AVX2",
      {
        platform: "Darwin",
        machine: "x86_64",
        sysctl: { "machdep.cpu.leaf7_features": "BMI1 AVX2 BMI2" },
      },
      "darwin-x64",
    ],
    [
      "Intel Mac without AVX2",
      {
        platform: "Darwin",
        machine: "x86_64",
        sysctl: { "machdep.cpu.features": "FPU SSE4.2 AVX1.0" },
      },
      "darwin-x64-baseline",
    ],
    [
      "a shell under Rosetta 2",
      { platform: "Darwin", machine: "x86_64", sysctl: { "sysctl.proc_translated": "1" } },
      "darwin-aarch64",
    ],
    [
      "Linux arm64",
      { platform: "Linux", machine: "aarch64" },
      existsSync("/etc/alpine-release") ? "linux-aarch64-musl" : "linux-aarch64",
    ],
    ["Linux x64 (this host's CPU)", { platform: "Linux", machine: "x86_64" }, hostLinuxX64],
  ];
  for (const [label, scenario, target] of targets) {
    test(`downloads bun-${target} on ${label}`, async () => {
      const result = await runInstaller({ ...scenario, download: { target, stampHash: true } });

      expect(result.downloads).toEqual([`${BUN_RELEASES}/bun-${target}.zip`]);
      expect(result.exitCode).toBe(0);
    });
  }
});
