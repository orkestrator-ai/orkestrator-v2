import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeWarmProbeDefinition, runWarmQualification } from "./claude-warm-runtime-support";

test("an exception after adding the probe fails evidence and cleans the latest definition before scratch", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "warm-cleanup-"));
  const failures: string[] = [];
  let definition: { entryId: string } | undefined;
  let revision = "before-add";
  let verdict: string | undefined;
  const error = new Error("injected control failure");
  try {
    await expect(
      runWarmQualification({
        failures,
        run: async () => {
          // One earlier step succeeded, then the add changed the source revision.
          definition = { entryId: "owned-entry" };
          revision = "after-add";
          throw error;
        },
        cleanup: [
          {
            name: "probe",
            run: () =>
              removeWarmProbeDefinition(
                async () => ({ definition, revision }),
                async (entryId, currentRevision) => {
                  expect(existsSync(scratch)).toBe(true);
                  expect(entryId).toBe("owned-entry");
                  expect(currentRevision).toBe("after-add");
                  definition = undefined;
                },
              ),
          },
          {
            name: "scratch",
            run: async () => {
              rmSync(scratch, { recursive: true, force: true });
            },
          },
        ],
        finish: async (value) => {
          verdict = value;
        },
      }),
    ).rejects.toBe(error);
    expect(verdict).toBe("failed");
    expect(failures).toContain(
      "Unexpected qualification exception; see the test failure for details.",
    );
    expect(definition).toBeUndefined();
    expect(existsSync(scratch)).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cleanup errors are recorded before publishing and do not skip later cleanup", async () => {
  const failures: string[] = [];
  let scratchRemoved = false;
  let verdict: string | undefined;
  await expect(
    runWarmQualification({
      failures,
      run: async () => {},
      cleanup: [
        {
          name: "probe",
          run: async () => {
            throw new Error("private response");
          },
        },
        {
          name: "scratch",
          run: async () => {
            scratchRemoved = true;
          },
        },
      ],
      finish: async (value) => {
        verdict = value;
        expect(scratchRemoved).toBe(true);
      },
    }),
  ).rejects.toThrow("Cleanup failed: probe");
  expect(verdict).toBe("failed");
  expect(failures).toEqual(["Cleanup failed: probe"]);
});

test("only completed runs with successful cleanup pass", async () => {
  let verdict: string | undefined;
  await runWarmQualification({
    failures: [],
    run: async () => {},
    cleanup: [],
    finish: async (value) => {
      verdict = value;
    },
  });
  expect(verdict).toBe("passed");
  let removed = false;
  await removeWarmProbeDefinition(
    async () => ({ revision: "new" }),
    async () => {
      removed = true;
    },
  );
  expect(removed).toBe(false);
});

test("a refused MCP removal is detected even when the command returns normally", async () => {
  await expect(
    removeWarmProbeDefinition(
      async () => ({ revision: "latest", definition: { entryId: "owned" } }),
      async () => {},
    ),
  ).rejects.toThrow("Probe MCP definition remains after removal");
});
