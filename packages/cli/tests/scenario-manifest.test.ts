import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordResolvedModel } from "../scenarios/cases.js";
import { RunManifest, type CliDriver, type CliResult } from "../scenarios/harness.js";

/**
 * A live run's manifest says which model the turn ran on, including an
 * unpinned run that took the provider's default.
 */

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function manifest(): Promise<RunManifest> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-scenario-manifest-"));
  directories.push(directory);
  return new RunManifest(path.join(directory, "manifest.json"));
}

async function startEntry(target: RunManifest, scenario = "live-session") {
  await target.record({
    at: new Date(0).toISOString(),
    scenario,
    stage: "session start --wait",
    argv: ["--json", "session", "start"],
    code: 0,
    durationMs: 1,
  });
}

/** A driver whose `session config get` answers with `respond`. */
function driver(respond: (argv: string[]) => Partial<CliResult> | Error): {
  cli: CliDriver;
  calls: string[][];
} {
  const calls: string[][] = [];
  const cli = {
    async run(argv: string[]) {
      calls.push(argv);
      const answer = respond(argv);
      if (answer instanceof Error) throw answer;
      return {
        argv,
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        ...answer,
      } satisfies CliResult;
    },
  } as unknown as CliDriver;
  return { cli, calls };
}

async function written(target: RunManifest) {
  return JSON.parse(await readFile(target.file!, "utf8")) as {
    entries: Array<{ stage: string; model?: unknown }>;
  };
}

describe("scenario manifest model record", () => {
  test("annotates only the latest entry for the scenario and stage", async () => {
    const target = await manifest();
    await startEntry(target, "other");
    await startEntry(target);
    await startEntry(target);
    const model = { requested: null, resolved: "zen/model" };
    expect(await target.annotate("live-session", "session start --wait", { model })).toBe(true);
    expect(target.entries.map((entry) => entry.model)).toEqual([undefined, undefined, model]);
    expect((await written(target)).entries[2]!.model).toEqual(model);
    expect(await target.annotate("live-session", "missing stage", { model })).toBe(false);
  });

  test("records the model an unpinned session reports in force", async () => {
    const target = await manifest();
    await startEntry(target);
    const { cli, calls } = driver(() => ({
      envelope: {
        ok: true,
        result: { sessionId: "s1", model: "opencode/default-model" },
      } as unknown as CliResult["envelope"],
    }));
    const model = await recordResolvedModel(
      { name: "live-session", cli, manifest: target },
      "session start --wait",
      null,
      "s1",
    );
    expect(calls).toEqual([["--json", "session", "config", "get", "s1"]]);
    expect(model).toEqual({
      requested: null,
      resolved: "opencode/default-model",
    });
    expect((await written(target)).entries[0]!.model).toEqual(model);
  });

  test("keeps the pin and records why the resolved model is unknown", async () => {
    const target = await manifest();
    await startEntry(target);
    const refused = driver(() => ({
      code: 4,
      envelope: {
        ok: false,
        error: { code: "connection-failed", message: "unavailable" },
      } as unknown as CliResult["envelope"],
    }));
    expect(
      await recordResolvedModel(
        { name: "live-session", cli: refused.cli, manifest: target },
        "session start --wait",
        "gpt-pinned",
        "s1",
      ),
    ).toEqual({
      requested: "gpt-pinned",
      resolved: null,
      readError: "connection-failed",
    });

    const malformed = driver(() => new Error("stdout is not a public envelope"));
    expect(
      await recordResolvedModel(
        { name: "live-session", cli: malformed.cli, manifest: target },
        "session start --wait",
        null,
        "s1",
      ),
    ).toEqual({
      requested: null,
      resolved: null,
      readError: "stdout is not a public envelope",
    });

    const unstarted = driver(() => new Error("never called"));
    expect(
      await recordResolvedModel(
        { name: "live-session", cli: unstarted.cli, manifest: target },
        "session start --wait",
        null,
        undefined,
      ),
    ).toEqual({ requested: null, resolved: null, readError: "no-session" });
    expect(unstarted.calls).toEqual([]);
    expect((await written(target)).entries[0]!.model).toEqual({
      requested: null,
      resolved: null,
      readError: "no-session",
    });
  });
});
