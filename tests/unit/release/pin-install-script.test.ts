import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  assertPublished,
  pinnedRelease,
  stampRelease,
} from "../../../scripts/pin-install-script.js";

const SCRIPT = '#!/usr/bin/env bash\nPINNED_RELEASE="2.36.1"\nPACKAGE="x"\n';

describe("pinning install.sh", () => {
  test("reads and moves the pin, leaving the rest of the script alone", () => {
    expect(pinnedRelease(SCRIPT)).toBe("2.36.1");
    const stamped = stampRelease(SCRIPT, "2.37.0");
    expect(pinnedRelease(stamped)).toBe("2.37.0");
    expect(stamped).toBe(SCRIPT.replace("2.36.1", "2.37.0"));
  });

  test("re-stamping the current version changes nothing", () => {
    expect(stampRelease(SCRIPT, "2.36.1")).toBe(SCRIPT);
  });

  test("refuses a prerelease, a moving tag and a step backwards", () => {
    expect(() => stampRelease(SCRIPT, "2.37.0-beta")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "2.37.0-alpha")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "latest")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "2.36.0")).toThrow("older than the current pin");
  });

  test("refuses a script with no pin line", () => {
    expect(() => pinnedRelease("#!/usr/bin/env bash\n")).toThrow("no PINNED_RELEASE line");
  });

  test("refuses a version npm does not have", async () => {
    const answer = (status: number) =>
      mock(async () => new Response(null, { status })) as unknown as typeof fetch;
    await expect(assertPublished("2.37.0", answer(200))).resolves.toBeUndefined();
    await expect(assertPublished("2.37.0", answer(404))).rejects.toThrow("not on npm (HTTP 404)");
  });
});

// Run the actual entry point in a disposable repository. A preload replaces only
// registry I/O; argument parsing, writes, diagnostics and process status stay real.
describe("pin command entry point", () => {
  async function runCommand(argument: string | undefined, status = 200) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pin-installer-"));
    try {
      const repository = path.resolve(import.meta.dir, "../../..");
      for (const file of [
        "scripts/pin-install-script.ts",
        "packages/protocol/src/host-maintenance.ts",
      ]) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await cp(path.join(repository, file), path.join(directory, file));
      }
      const installer = path.join(directory, "apps/web-public/public/install.sh");
      await mkdir(path.dirname(installer), { recursive: true });
      await writeFile(installer, SCRIPT);
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "2.37.0" }));
      const preload = path.join(directory, "registry.ts");
      await writeFile(
        preload,
        `globalThis.fetch = (async (url) => {
        if (url !== "https://registry.npmjs.org/orkestrator/2.37.0") throw new Error("Unexpected registry URL: " + url);
        return new Response(null, { status: ${status} });
      }) as typeof fetch;`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          path.join(directory, "scripts/pin-install-script.ts"),
          ...(argument === undefined ? [] : [argument]),
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr, script: await readFile(installer, "utf8") };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("defaults to package.json and writes the published release", async () => {
    const result = await runCommand(undefined);
    expect(result.code).toBe(0);
    expect(result.script).toBe(SCRIPT.replace("2.36.1", "2.37.0"));
    expect(result.stdout).toContain("orkestrator@2.37.0");
  });

  test("strips a leading v from an explicit version", async () => {
    const result = await runCommand("v2.37.0");
    expect(result.code).toBe(0);
    expect(result.script).toBe(SCRIPT.replace("2.36.1", "2.37.0"));
  });

  test("registry refusal leaves the installer untouched and exits non-zero", async () => {
    const result = await runCommand(undefined, 404);
    expect(result.code).toBe(1);
    expect(result.script).toBe(SCRIPT);
    expect(result.stderr).toContain("not on npm (HTTP 404)");
    expect(result.stdout).toBe("");
  });
});
