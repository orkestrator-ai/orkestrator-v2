import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
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
  childPath: string;
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
  missingBinary?: boolean;
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
  hasher?: "sha256sum" | "shasum" | "none";
  missingUnzip?: boolean;
  alpine?: boolean;
  cpuinfo?: string;
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

const HOST_TOOL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/bin/core_perl";

function defaultHasher(toolPath = HOST_TOOL_PATH): "sha256sum" | "shasum" {
  return Bun.which("sha256sum", { PATH: toolPath }) ? "sha256sum" : "shasum";
}

function realTool(name: string): string {
  const found = Bun.which(name, { PATH: HOST_TOOL_PATH });
  if (!found) throw new Error(`${name} is required to run the install.sh tests`);
  return found;
}

/** Stands in for Bun. `install` leaves a fetched package without a release runtime. */
function bunStub(label: string, version: string, installLog: string): string {
  return `case "$1" in
  --version) printf '%s\\n' '${version}' ;;
  install)
    printf '%s\\n' "$*" >> '${installLog}'
    printf '%s\\n' "$PATH" > '${installLog}.path'
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
    hasher = defaultHasher(),
    missingUnzip = false,
    alpine = false,
    cpuinfo = "flags : avx2",
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

  for (const tool of ["mktemp", "rm", "mkdir", "cp", "mv", "chmod", "ln", "sleep"]) {
    await symlink(realTool(tool), path.join(pathDirectory, tool));
  }
  if (hasher !== "none") {
    await symlink(realTool(hasher), path.join(pathDirectory, hasher));
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

  // Replace only the host-file reads in the fixture copy, never on the host.
  const alpineFile = path.join(sandbox, "alpine-release");
  const cpuinfoFile = path.join(sandbox, "cpuinfo");
  if (alpine) await writeFile(alpineFile, "3.22.0\n");
  await writeFile(cpuinfoFile, cpuinfo);
  let script = SCRIPT.replaceAll("/etc/alpine-release", alpineFile).replaceAll(
    "/proc/cpuinfo",
    cpuinfoFile,
  );
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
    if (!missingUnzip)
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
          download.missingBinary ? ":" : `cp '${downloadedBun}' "$dir/$name/bun"`,
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
    childPath: lines(`${installLog}.path`)[0] ?? "",
  };
}

// The archive Bun's own installer would choose, per host.
const TARGETS: Array<[string, InstallerScenario, string]> = [
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
  ["Linux arm64", { platform: "Linux", machine: "aarch64" }, "linux-aarch64"],
  [
    "Linux arm64 musl",
    { platform: "Linux", machine: "aarch64", alpine: true },
    "linux-aarch64-musl",
  ],
  ...[false, true].flatMap((alpine): Array<[string, InstallerScenario, string]> =>
    [false, true].map((avx2) => [
      `Linux x64 ${alpine ? "musl" : "glibc"} ${avx2 ? "AVX2" : "baseline"}`,
      {
        platform: "Linux",
        machine: "x86_64",
        alpine,
        cpuinfo: avx2 ? "flags : avx2" : "flags : sse2",
      },
      `linux-x64${alpine ? "-musl" : ""}${avx2 ? "" : "-baseline"}`,
    ]),
  ),
];

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
    expect(result.childPath.split(":")[0]).toBe(result.bunDirectory);
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

  test("selects the default hasher on a host with only shasum", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-hasher-"));
    temporaryDirectories.push(directory);
    await writeStub(path.join(directory, "shasum"), "exit 0");
    expect(defaultHasher(directory)).toBe("shasum");
    await writeStub(path.join(directory, "sha256sum"), "exit 0");
    expect(defaultHasher(directory)).toBe("sha256sum");
  });

  for (const [label, scenario, message] of [
    ["missing unzip", { missingUnzip: true }, "unzip is required"],
    ["missing hash tools", { hasher: "none" }, "sha256sum or shasum is required"],
    [
      "missing archive binary",
      { download: { target: "darwin-aarch64", stampHash: true, missingBinary: true } },
      "archive has no bun-darwin-aarch64/bun",
    ],
  ] as const) {
    test(`refuses ${label} without installing or launching Bun`, async () => {
      const result = await runInstaller({
        download: { target: "darwin-aarch64", stampHash: true },
        ...scenario,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.installs).toEqual([]);
      expect(result.stdout).toBe("");
      expect(existsSync(path.join(result.bunDirectory, "bun"))).toBe(false);
      expect(result.leftInTmp).toEqual([]);
    });
  }

  test("all nine archive hashes match the published Bun checksum fixture", async () => {
    // Captured from the release's SHASUMS256.txt on 2026-11-05:
    // https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt
    // Keep this fixture versioned; a Bun bump must capture the new release's list.
    const checksums = await readFile(
      path.join(root, `tests/fixtures/bun-release/SHASUMS256-${PINNED_BUN}.txt`),
      "utf8",
    );
    const published = new Map(
      checksums
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, archive] = line.trim().split(/\s+/);
          return [archive!, hash!];
        }),
    );
    const hashes = Array.from(SCRIPT.matchAll(/^BUN_SHA256_([A-Z0-9_]+)="([a-f0-9]{64})"$/gm));
    expect(hashes).toHaveLength(9);
    for (const [, target, hash] of hashes) {
      const archive = `bun-${target!.toLowerCase().replaceAll("_", "-")}.zip`;
      expect({ archive, hash }).toEqual({ archive, hash: published.get(archive) });
    }
  });

  // Two hosts through the whole script, each stamping the hash only for the
  // expected archive, so choosing another one fails the hash check too. One
  // reads macOS sysctl, the other the Alpine marker and /proc/cpuinfo; the rest
  // of the matrix runs in one shell below.
  for (const label of ["Intel Mac without AVX2", "Linux x64 musl baseline"]) {
    const [, scenario, target] = TARGETS.find(([name]) => name === label)!;
    test(`downloads, checks and launches bun-${target} on ${label}`, async () => {
      const result = await runInstaller({ ...scenario, download: { target, stampHash: true } });

      expect(result.downloads).toEqual([`${BUN_RELEASES}/bun-${target}.zip`]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`downloaded-bun x ${PACKAGE}`);
    });
  }
});

type SelectionResult = {
  /** What `bun_target` printed, or undefined when it refused the host. */
  target?: string;
  /** The SHA-256 `bun_sha256` states for that archive. */
  sha256?: string;
  /** `install_bun`'s exit status, with curl logging its URL and then failing. */
  installExit: number;
  installStderr: string;
  downloads: string[];
};

type GateResult = { exitCode: number; stdout: string; stderr: string; installs: string[] };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The sysctl stub `runInstaller` writes, as a shell function. */
function sysctlFunction(values: Record<string, string>): string {
  return [
    "sysctl() {",
    "  shift",
    "  local status=1 key",
    '  for key in "$@"; do',
    '    case "$key" in',
    ...Object.entries(values).map(
      ([key, value]) => `      ${key}) printf '%s\\n' ${shellQuote(value)}; status=0 ;;`,
    ),
    "    esac",
    "  done",
    "  return $status",
    "}",
  ].join("\n");
}

/**
 * Evaluates every host case in one bash process. It sources install.sh's own
 * definitions (everything above the final `main "$@"`), and each case runs in
 * its own subshell with `uname`, `sysctl`, `curl` and `unzip` as shell
 * functions answering for that host, and its own Alpine marker and cpuinfo.
 */
async function runHostCasesInOneShell(
  selections: ReadonlyArray<readonly [string, InstallerScenario]>,
  gates: ReadonlyArray<readonly [string, InstallerScenario]>,
): Promise<{ selections: Map<string, SelectionResult>; gates: Map<string, GateResult> }> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "orkestrator-install-sh-hosts-"));
  temporaryDirectories.push(sandbox);
  const lines = SCRIPT.trimEnd().split("\n");
  expect(lines.at(-1)).toBe('main "$@"');
  const definitions = path.join(sandbox, "install-definitions.sh");
  await writeFile(
    definitions,
    lines
      .slice(0, -1)
      .join("\n")
      .replaceAll("/etc/alpine-release", '"${CASE_DIR}/alpine-release"')
      .replaceAll("/proc/cpuinfo", '"${CASE_DIR}/cpuinfo"'),
  );
  const home = path.join(sandbox, "home");
  const tmp = path.join(sandbox, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });

  const harness = [
    `source ${shellQuote(definitions)}`,
    // Each case's subshell turns errexit back on, as the script runs.
    "set +e",
    `uname() { case "$1" in -m) printf '%s\\n' "$CASE_MACHINE" ;; *) printf '%s\\n' "$CASE_PLATFORM" ;; esac; }`,
    'curl() { local arg url=""; for arg in "$@"; do case "$arg" in https://*) url="$arg" ;; esac; done; printf \'%s\\n\' "$url" >> "$CASE_DIR/downloads"; return 22; }',
    "unzip() { :; }",
  ];
  const selectionDirectories = new Map<string, string>();
  const gateDirectories = new Map<string, string>();
  const caseSetup = async (
    index: string,
    scenario: InstallerScenario,
  ): Promise<{ directory: string; prelude: string }> => {
    const directory = path.join(sandbox, index);
    await mkdir(directory, { recursive: true });
    if (scenario.alpine) await writeFile(path.join(directory, "alpine-release"), "3.22.0\n");
    await writeFile(path.join(directory, "cpuinfo"), scenario.cpuinfo ?? "flags : avx2");
    return {
      directory,
      prelude: [
        `CASE_DIR=${shellQuote(directory)}`,
        `CASE_PLATFORM=${shellQuote(scenario.platform ?? "Darwin")}`,
        `CASE_MACHINE=${shellQuote(scenario.machine ?? "arm64")}`,
        sysctlFunction(scenario.sysctl ?? {}),
      ].join("\n"),
    };
  };
  for (const [index, [label, scenario]] of selections.entries()) {
    const { directory, prelude } = await caseSetup(`selection-${index}`, scenario);
    selectionDirectories.set(label, directory);
    harness.push(
      prelude,
      'if target="$(bun_target)"; then printf \'%s\' "$target" > "$CASE_DIR/target"; bun_sha256 "$target" > "$CASE_DIR/sha256"; fi',
      '( set -e; WORK="$CASE_DIR/work"; install_bun "$CASE_DIR/bun/bin" ) 2> "$CASE_DIR/install.stderr"',
      'printf \'%s\' "$?" > "$CASE_DIR/install.exit"',
    );
  }
  for (const [index, [label, scenario]] of gates.entries()) {
    const { directory, prelude } = await caseSetup(`gate-${index}`, scenario);
    gateDirectories.set(label, directory);
    const pathDirectory = path.join(directory, "path");
    await writeStub(
      path.join(pathDirectory, "bun"),
      bunStub("path-bun", PINNED_BUN, path.join(directory, "installs.log")),
    );
    harness.push(
      prelude,
      `( set -e; PATH=${shellQuote(`${pathDirectory}:${HOST_TOOL_PATH}`)}; main ) > "$CASE_DIR/stdout" 2> "$CASE_DIR/stderr"`,
      'printf \'%s\' "$?" > "$CASE_DIR/exit"',
    );
  }

  const child = Bun.spawn(["/bin/bash", "-c", harness.join("\n")], {
    cwd: sandbox,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: HOST_TOOL_PATH, HOME: home, TMPDIR: tmp, BUN_INSTALL: path.join(sandbox, "bun") },
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

  const text = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const lineList = (file: string) => (text(file) ?? "").split("\n").filter(Boolean);
  return {
    selections: new Map(
      Array.from(selectionDirectories, ([label, directory]) => [
        label,
        {
          target: text(path.join(directory, "target")),
          sha256: text(path.join(directory, "sha256"))?.trim(),
          installExit: Number(text(path.join(directory, "install.exit"))),
          installStderr: text(path.join(directory, "install.stderr")) ?? "",
          downloads: lineList(path.join(directory, "downloads")),
        },
      ]),
    ),
    gates: new Map(
      Array.from(gateDirectories, ([label, directory]) => [
        label,
        {
          exitCode: Number(text(path.join(directory, "exit"))),
          stdout: (text(path.join(directory, "stdout")) ?? "").trim(),
          stderr: (text(path.join(directory, "stderr")) ?? "").trim(),
          installs: lineList(path.join(directory, "installs.log")),
        },
      ]),
    ),
  };
}

describe("web-public install.sh host selection, in one shell", () => {
  const unsupportedArchitecture: [string, InstallerScenario] = [
    "Linux riscv64",
    { platform: "Linux", machine: "riscv64" },
  ];
  const gates: Array<[string, InstallerScenario]> = [
    ["MINGW64_NT-10.0", { platform: "MINGW64_NT-10.0" }],
    ...["Darwin", "Linux"].map((platform): [string, InstallerScenario] => [
      platform,
      { platform, machine: "aarch64" },
    ]),
  ];
  let results: Awaited<ReturnType<typeof runHostCasesInOneShell>>;

  beforeAll(async () => {
    results = await runHostCasesInOneShell(
      [...TARGETS.map(([label, scenario]) => [label, scenario] as const), unsupportedArchitecture],
      gates,
    );
  });

  test("refuses to run on an unsupported platform", () => {
    const result = results.gates.get("MINGW64_NT-10.0")!;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("macOS and Linux only");
    // Nothing runs before the platform gate has passed.
    expect(result.stdout).toBe("");
    expect(result.installs).toEqual([]);
  });

  for (const platform of ["Darwin", "Linux"]) {
    test(`runs on supported platform ${platform}`, () => {
      const result = results.gates.get(platform)!;
      expect({ platform, exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        platform,
        exitCode: 0,
        stdout: `path-bun x ${PACKAGE}`,
      });
      expect(result.installs).toHaveLength(1);
    });
  }

  test("refuses an architecture Bun publishes no build for", () => {
    const result = results.selections.get(unsupportedArchitecture[0])!;

    expect(result.target).toBeUndefined();
    expect(result.installExit).toBe(1);
    expect(result.installStderr).toContain("Bun publishes no build for Linux riscv64");
    expect(result.downloads).toEqual([]);
  });

  // The archive Bun's own installer would choose, the URL install_bun asks for,
  // and the hash it checks the download against, which is that archive's own:
  // any other choice would fail the hash check.
  for (const [label, , target] of TARGETS) {
    test(`downloads bun-${target} on ${label}`, () => {
      const result = results.selections.get(label)!;
      const variable = `BUN_SHA256_${target.toUpperCase().replaceAll("-", "_")}`;

      expect(result.target).toBe(target);
      expect(result.sha256).toBe(
        new RegExp(`^${variable}="([0-9a-f]{64})"$`, "m").exec(SCRIPT)![1],
      );
      expect(result.downloads).toEqual([`${BUN_RELEASES}/bun-${target}.zip`]);
      // curl fails here by design, after the URL was chosen.
      expect(result.installExit).toBe(1);
      expect(result.installStderr).toContain(
        `Could not download ${BUN_RELEASES}/bun-${target}.zip`,
      );
    });
  }
});
