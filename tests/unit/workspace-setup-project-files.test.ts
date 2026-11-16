import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Runs the project-file phase of `docker/workspace-setup.sh` (from
 * `project_input` to the project setup script) against temporary folders:
 * the staged inputs the backend copies into a container (`/project-env`,
 * `/project-files`, `/opencode-project-json`) and a workspace standing in for
 * the cloned branch. The branch is repository content, so it can commit a
 * link where a folder or the file should be; the copy must refuse those
 * paths instead of writing through them.
 */

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..", "..");
const setupScript = join(repoRoot, "docker", "workspace-setup.sh");
const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPhase(inputs: string, workspace: string): string {
  const setup = readFileSync(setupScript, "utf8");
  const start = setup.indexOf("project_input() {");
  const end = setup.indexOf("# Run orkestrator-ai.json setup script");
  if (start < 0 || end < 0) throw new Error("workspace-setup.sh copy phase markers moved");
  return setup
    .slice(start, end)
    .replaceAll(`printf '/%s\\n' "$1"`, `printf '%s/%s\\n' "${inputs}" "$1"`)
    .replaceAll("/run/orkestrator-inputs", `${inputs}/no-relay`)
    .replaceAll("/project-files", `${inputs}/project-files`)
    .replaceAll("/env/", `${inputs}/env/`)
    .replaceAll("/tmp/opencode.json.tmp", `${inputs}/opencode.json.tmp`)
    .replaceAll("/workspace", workspace);
}

function write(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ork-setup-project-files-"));
  dirs.push(root);
  const inputs = join(root, "inputs");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(inputs);
  mkdirSync(workspace);
  mkdirSync(outside);
  return { inputs, workspace, outside };
}

function run(inputs: string, workspace: string): { code: number | null; stdout: string } {
  const harness = `set -e\nGREEN=""; BLUE=""; YELLOW=""; NC=""\n${copyPhase(inputs, workspace)}\necho phase-finished`;
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  return { code: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe.skipIf(!jqAvailable)("workspace-setup.sh project-file copy", () => {
  test("copies staged files to the same paths, keeping spaces in names", () => {
    const { inputs, workspace } = fixture();
    write(join(inputs, "project-env", ".env"), "A=1\n");
    write(join(inputs, "project-files", "config", "app.json"), "{}\n");
    write(join(inputs, "project-files", "config", "app.env "), "TRAILING=1\n");
    write(join(inputs, "project-files", " leading.env"), "LEADING=1\n");
    write(join(inputs, "opencode-project-json"), '{"model":"test"}');
    // A committed regular file is replaced, as before.
    write(join(workspace, "config", "app.json"), "committed\n");

    const result = run(inputs, workspace);

    expect(result.stdout).toContain("phase-finished");
    expect(result.code).toBe(0);
    expect(readFileSync(join(workspace, ".env"), "utf8")).toBe("A=1\n");
    expect(readFileSync(join(workspace, "config", "app.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(workspace, "config", "app.env "), "utf8")).toBe("TRAILING=1\n");
    expect(readFileSync(join(workspace, " leading.env"), "utf8")).toBe("LEADING=1\n");
    expect(readFileSync(join(workspace, "opencode.json"), "utf8")).toBe('{"model":"test"}');
    expect(result.stdout).not.toContain("Skipped");
  });

  test("never writes through a committed link to a folder", () => {
    const { inputs, workspace, outside } = fixture();
    write(join(outside, "auth.json"), "secret\n");
    symlinkSync(outside, join(workspace, "config"));
    write(join(inputs, "project-files", "config", "auth.json"), "project\n");
    write(join(inputs, "project-files", "config", "nested", "other.json"), "project\n");
    write(join(inputs, "project-files", "kept.json"), "kept\n");

    const result = run(inputs, workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("phase-finished");
    expect(readFileSync(join(outside, "auth.json"), "utf8")).toBe("secret\n");
    expect(existsSync(join(outside, "nested"))).toBe(false);
    expect(result.stdout).toContain("Skipped config/auth.json");
    expect(result.stdout).toContain("Skipped config/nested/other.json");
    expect(readFileSync(join(workspace, "kept.json"), "utf8")).toBe("kept\n");
  });

  test("never writes through a committed link where the file should be", () => {
    const { inputs, workspace, outside } = fixture();
    write(join(outside, "target"), "outside\n");
    for (const name of [".env", ".env.local", "opencode.json", "app.json"]) {
      symlinkSync(join(outside, "target"), join(workspace, name));
    }
    // A dangling link would otherwise create its target.
    symlinkSync(join(outside, "created"), join(workspace, "dangling.json"));
    write(join(inputs, "project-env", ".env"), "A=1\n");
    write(join(inputs, "project-env", ".env.local"), "B=2\n");
    write(join(inputs, "opencode-project-json"), '{"model":"test"}');
    write(join(inputs, "project-files", "app.json"), "project\n");
    write(join(inputs, "project-files", "dangling.json"), "project\n");

    const result = run(inputs, workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("phase-finished");
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("outside\n");
    expect(existsSync(join(outside, "created"))).toBe(false);
    for (const name of [".env", ".env.local", "opencode.json", "app.json", "dangling.json"]) {
      expect(lstatSync(join(workspace, name)).isSymbolicLink()).toBe(true);
      expect(result.stdout).toContain(`Skipped ${name}`);
    }
    expect(result.stdout).not.toContain("opencode.json ready");
  });

  test("refuses a path whose folder is a committed file", () => {
    const { inputs, workspace } = fixture();
    write(join(workspace, "config"), "a file\n");
    write(join(inputs, "project-files", "config", "app.json"), "project\n");

    const result = run(inputs, workspace);

    expect(result.code).toBe(0);
    expect(readFileSync(join(workspace, "config"), "utf8")).toBe("a file\n");
    expect(result.stdout).toContain("Skipped config/app.json");
  });
});
