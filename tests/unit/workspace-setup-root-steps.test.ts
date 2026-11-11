import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs the root phase of `docker/workspace-setup.sh` (`run_project_root_setup`)
 * the way the script does, with `run_root_step` replaced by a stub that logs
 * each step instead of calling `sudo run-root-setup.sh`, then the regular
 * setup step the real script runs next.
 */

// Every case runs bash and jq for real.
setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");
const ROOT_REASON_MARKER = "\u001b]9999;setup_failure_reason=root-steps-need-full-network\u0007";
const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runRootPhase(input: {
  root?: unknown;
  networkMode?: string | null;
  failingStep?: string;
}): { code: number | null; stdout: string; steps: string[]; containerSetupRan: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "ork-root-steps-"));
  dirs.push(dir);
  const config = join(dir, "orkestrator-ai.json");
  const networkModeFile = join(dir, "network-mode");
  const stepLog = join(dir, "steps.log");
  const setupLog = join(dir, "setup.log");
  writeFileSync(stepLog, "");
  writeFileSync(
    config,
    JSON.stringify({
      ...(input.root === undefined ? {} : { root: input.root }),
      setupContainer: ["echo setup"],
    }),
  );
  if (input.networkMode !== null) {
    writeFileSync(networkModeFile, `${input.networkMode ?? "restricted"}\n`);
  }
  const harness = `
set -e
GREEN=""; BLUE=""; RED=""; NC=""
eval "$(sed -n '/^project_root_step_count() {/,/^}$/p; /^run_root_step() {/,/^}$/p; /^run_project_root_setup() {/,/^}$/p' "$1")"
STEP_LOG="$3"; FAILING_STEP="$5"
run_root_step() {
    printf '%s\\n' "$1" >> "$STEP_LOG"
    [ "$1" != "$FAILING_STEP" ]
}
run_project_root_setup "$2" "$4" || exit $?
echo ran >> "$6"
`;
  const result = spawnSync(
    "bash",
    [
      "-c",
      harness,
      "--",
      setupScript,
      config,
      stepLog,
      networkModeFile,
      input.failingStep ?? "",
      setupLog,
    ],
    { encoding: "utf8" },
  );
  let containerSetupRan = false;
  try {
    containerSetupRan = readFileSync(setupLog, "utf8").includes("ran");
  } catch {
    containerSetupRan = false;
  }
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    steps: readFileSync(stepLog, "utf8").split("\n").filter(Boolean),
    containerSetupRan,
  };
}

describe.skipIf(!jqAvailable)("workspace-setup.sh root phase", () => {
  for (const networkMode of ["restricted", "full"]) {
    test(`no root field is a no-op (${networkMode})`, () => {
      const run = runRootPhase({ networkMode });
      expect(run.code).toBe(0);
      expect(run.steps).toEqual([]);
      expect(run.stdout).toContain("No root setup defined");
      expect(run.stdout).not.toContain(ROOT_REASON_MARKER);
      expect(run.containerSetupRan).toBe(true);
    });

    for (const root of [[], "", [""], [null]]) {
      test(`an empty root field ${JSON.stringify(root)} is a no-op (${networkMode})`, () => {
        const run = runRootPhase({ root, networkMode });
        expect(run.code).toBe(0);
        expect(run.steps).toEqual([]);
        expect(run.stdout).not.toContain("Root setup steps cannot run");
        expect(run.stdout).not.toContain(ROOT_REASON_MARKER);
        expect(run.containerSetupRan).toBe(true);
      });
    }
  }

  for (const root of [["apt-get install -y foo"], "apt-get install -y foo"]) {
    test(`root steps fail fast with the reason marker in restricted mode (${typeof root})`, () => {
      const run = runRootPhase({ root, networkMode: "restricted" });
      expect(run.code).toBe(1);
      expect(run.steps).toEqual([]);
      expect(run.stdout).toContain("Root setup steps cannot run in this environment");
      expect(run.stdout).toContain("environment's network is restricted");
      expect(run.stdout).toContain(ROOT_REASON_MARKER);
      expect(run.containerSetupRan).toBe(false);
    });

    test(`root steps run in full mode, then the regular setup (${typeof root})`, () => {
      const run = runRootPhase({ root, networkMode: "full" });
      expect(run.code).toBe(0);
      expect(run.steps).toEqual(["apt-get install -y foo"]);
      expect(run.stdout).toContain("Root setup completed successfully!");
      expect(run.stdout).not.toContain(ROOT_REASON_MARKER);
      expect(run.containerSetupRan).toBe(true);
    });
  }

  test("array steps run in order, skipping empty entries", () => {
    const run = runRootPhase({ root: ["first", "", "second"], networkMode: "full" });
    expect(run.code).toBe(0);
    expect(run.steps).toEqual(["first", "second"]);
  });

  test("a failing root step in full mode stops the rest and fails setup without a reason", () => {
    const run = runRootPhase({
      root: ["first", "broken", "never"],
      networkMode: "full",
      failingStep: "broken",
    });
    expect(run.code).toBe(1);
    expect(run.steps).toEqual(["first", "broken"]);
    expect(run.stdout).toContain("Root setup failed with code 1");
    expect(run.stdout).toContain("A root step in orkestrator-ai.json exited with an error");
    expect(run.stdout).not.toContain(ROOT_REASON_MARKER);
    expect(run.containerSetupRan).toBe(false);
  });

  test("without a recorded network mode the steps are tried and the wrapper decides", () => {
    const run = runRootPhase({ root: ["step"], networkMode: null });
    expect(run.code).toBe(0);
    expect(run.steps).toEqual(["step"]);
    expect(run.stdout).not.toContain(ROOT_REASON_MARKER);
    expect(run.containerSetupRan).toBe(true);
  });

  test("the script runs the root phase through the function and stops on its failure", () => {
    const script = readFileSync(setupScript, "utf8");
    expect(script).toContain(
      "run_project_root_setup /workspace/orkestrator-ai.json /etc/orkestrator/network-mode || exit $?",
    );
    expect(script).toContain("sudo /usr/local/bin/run-root-setup.sh");
  });
});
