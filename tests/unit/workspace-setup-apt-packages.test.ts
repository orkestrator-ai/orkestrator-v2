import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs the package phase of `docker/workspace-setup.sh`
 * (`run_project_apt_packages`, to-do 7770) the way the script does, with
 * `run_apt_install` replaced by a stub that logs its arguments and exits with
 * a chosen status instead of calling `sudo orkestrator-apt-install`, then the
 * regular setup step the real script runs next.
 */

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");
const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
const marker = (reason: string) => `\u001b]9999;setup_failure_reason=${reason}\u0007`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runPackagePhase(input: { config: Record<string, unknown>; installerExit?: number }): {
  code: number | null;
  stdout: string;
  installs: string[][];
  containerSetupRan: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), "ork-apt-phase-"));
  dirs.push(dir);
  const config = join(dir, "orkestrator-ai.json");
  const installLog = join(dir, "installs.log");
  const setupLog = join(dir, "setup.log");
  writeFileSync(installLog, "");
  writeFileSync(setupLog, "");
  writeFileSync(config, JSON.stringify({ ...input.config, setupContainer: ["echo setup"] }));
  const harness = `
set -e
GREEN=""; BLUE=""; RED=""; NC=""
eval "$(sed -n '/^project_apt_packages() {/,/^}$/p; /^run_project_apt_packages() {/,/^}$/p' "$1")"
INSTALL_LOG="$3"; INSTALL_EXIT="$4"
run_apt_install() {
    printf '%s\\n' "$*" >> "$INSTALL_LOG"
    return "$INSTALL_EXIT"
}
run_project_apt_packages "$2" || exit $?
echo ran >> "$5"
`;
  const result = spawnSync(
    "bash",
    [
      "-c",
      harness,
      "--",
      setupScript,
      config,
      installLog,
      String(input.installerExit ?? 0),
      setupLog,
    ],
    { encoding: "utf8" },
  );
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    installs: readFileSync(installLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")),
    containerSetupRan: readFileSync(setupLog, "utf8").includes("ran"),
  };
}

describe.skipIf(!jqAvailable)("workspace-setup.sh package phase", () => {
  for (const config of [{}, { aptPackages: null }, { aptPackages: [] }, { aptPackages: [""] }]) {
    test(`${JSON.stringify(config)} installs nothing`, () => {
      const run = runPackagePhase({ config });
      expect(run.code).toBe(0);
      expect(run.installs).toEqual([]);
      expect(run.stdout).toContain("No system packages declared");
      expect(run.containerSetupRan).toBe(true);
    });
  }

  test("each declared name is one installer argument, in order", () => {
    const run = runPackagePhase({ config: { aptPackages: ["libvips-dev", "", "ffmpeg"] } });
    expect(run.code).toBe(0);
    expect(run.installs).toEqual([["libvips-dev", "ffmpeg"]]);
    expect(run.stdout).toContain("From Debian's archive (deb.debian.org): libvips-dev ffmpeg");
    expect(run.stdout).toContain("System packages installed");
    expect(run.containerSetupRan).toBe(true);
  });

  for (const aptPackages of ["libvips-dev", { name: "x" }, ["ok", 3], [true]]) {
    test(`${JSON.stringify(aptPackages)} is refused before the installer runs`, () => {
      const run = runPackagePhase({ config: { aptPackages } });
      expect(run.code).toBe(1);
      expect(run.installs).toEqual([]);
      expect(run.stdout).toContain("must be a list of Debian package");
      expect(run.stdout).toContain(marker("apt-packages-refused"));
      expect(run.containerSetupRan).toBe(false);
    });
  }

  for (const [exit, reason, text] of [
    [3, "apt-packages-refused", "was refused"],
    [4, "apt-packages-unsupported-runtime", "firewall runs inside it"],
    [5, "apt-packages-archive-unreachable", "add deb.debian.org"],
    [6, "apt-packages-install-failed", "apt-get failed"],
    [1, "apt-packages-install-failed", "apt-get failed"],
  ] as const) {
    test(`installer status ${exit} stops setup with ${reason}`, () => {
      const run = runPackagePhase({
        config: { aptPackages: ["libvips-dev"] },
        installerExit: exit,
      });
      expect(run.code).toBe(exit);
      expect(run.stdout).toContain(text);
      expect(run.stdout).toContain(marker(reason));
      expect(run.containerSetupRan).toBe(false);
    });
  }

  test("the script installs packages before root steps and the regular setup", () => {
    const script = readFileSync(setupScript, "utf8");
    const packages = script.indexOf("run_project_apt_packages /workspace/orkestrator-ai.json");
    expect(packages).toBeGreaterThan(0);
    expect(packages).toBeLessThan(script.indexOf("run_project_root_setup /workspace/"));
    expect(script).toContain("sudo -n /usr/local/bin/orkestrator-apt-install");
  });
});
