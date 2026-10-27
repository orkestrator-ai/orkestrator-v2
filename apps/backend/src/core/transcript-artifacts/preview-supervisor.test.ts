import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LEGACY_PREVIEW_SCRATCH_STALE_MS,
  PREVIEW_SCRATCH_PREFIX,
  PREVIEW_SCRATCH_STALE_MS,
  superviseWorker,
  sweepStalePreviewScratch,
} from "./preview-supervisor.js";

for (const source of ["split-utf8", "malformed", "output-limit"]) {
  test(`stdout framing: ${source}`, async () => {
    const worker = superviseWorker(
      {
        isolation: "process",
        command: process.execPath,
        args: [path.join(import.meta.dir, "fixtures/fake-preview-worker.ts")],
      },
      { job: { kind: "mermaid", source, theme: "light" } } as Parameters<typeof superviseWorker>[1],
      { workerWallMs: 5000, readinessHardMs: 3000, mermaidRenderMs: 3000, cleanupGraceMs: 100 },
    );
    try {
      const outcome = await worker.outcome;
      if (source === "split-utf8") {
        expect(outcome.type).toBe("result");
        if (outcome.type === "result") expect(outcome.result.effectiveHtml).toBe("<p>漢字 😀</p>");
      } else
        expect(outcome).toMatchObject({
          type: "crashed",
          reason: source === "malformed" ? "protocol" : "output-limit",
        });
    } finally {
      worker.cancel();
      expect((await worker.exited).verified).toBe(true);
    }
  }, 10000);
}

test("a process worker's scratch is named for its backend and removed after a verified exit", async () => {
  const worker = superviseWorker(
    {
      isolation: "process",
      command: process.execPath,
      args: [path.join(import.meta.dir, "fixtures/fake-preview-worker.ts")],
    },
    { job: { kind: "mermaid", source: "split-utf8", theme: "light" } } as Parameters<
      typeof superviseWorker
    >[1],
    { workerWallMs: 5000, readinessHardMs: 3000, mermaidRenderMs: 3000, cleanupGraceMs: 100 },
  );
  const scratch = worker.scratchDir()!;
  expect(path.basename(scratch)).toMatch(
    new RegExp(`^${PREVIEW_SCRATCH_PREFIX}${process.pid}-[A-Za-z0-9]{6}$`),
  );
  await worker.outcome;
  expect((await worker.exited).verified).toBe(true);
  expect(existsSync(scratch)).toBe(false);
}, 10000);

test("startup recovery removes only stale scratch of backends that have exited", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ork-preview-scratch-sweep-"));
  try {
    const now = Date.now();
    const make = (name: string, ageMs: number, file = false) => {
      const target = path.join(root, name);
      if (file) writeFileSync(target, "");
      else mkdirSync(path.join(target, ".config"), { recursive: true });
      const time = (now - ageMs) / 1000;
      utimesSync(target, time, time);
      return target;
    };
    const old = PREVIEW_SCRATCH_STALE_MS + 60_000;
    const stale = make(`${PREVIEW_SCRATCH_PREFIX}4000001-aB3dE9`, old);
    const fresh = make(`${PREVIEW_SCRATCH_PREFIX}4000002-aB3dE9`, 1_000);
    const live = make(`${PREVIEW_SCRATCH_PREFIX}4000003-aB3dE9`, old);
    const own = make(`${PREVIEW_SCRATCH_PREFIX}${process.pid}-aB3dE9`, old);
    writeFileSync(path.join(live, ".ork-preview-owner"), "original-backend");
    writeFileSync(path.join(own, ".ork-preview-owner"), "original-backend");
    const legacy = make(`${PREVIEW_SCRATCH_PREFIX}aB3dE9`, old);
    const legacyStale = make(
      `${PREVIEW_SCRATCH_PREFIX}xY7zW2`,
      LEGACY_PREVIEW_SCRATCH_STALE_MS + old,
    );
    const file = make(`${PREVIEW_SCRATCH_PREFIX}4000004-aB3dE9`, old, true);
    const other = make("ork-artifact-preview-notes", old);

    const removed = await sweepStalePreviewScratch({
      root,
      now,
      isProcessAlive: (pid) => pid === 4000003 || pid === process.pid,
      processStartIdentity: () => "original-backend",
    });

    expect(removed.sort()).toEqual([stale, legacyStale].sort());
    for (const gone of [stale, legacyStale]) expect(existsSync(gone)).toBe(false);
    for (const kept of [fresh, live, own, legacy, file, other]) expect(existsSync(kept)).toBe(true);
    expect(await sweepStalePreviewScratch({ root: path.join(root, "missing") })).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery distinguishes a recycled live PID from the original backend", async () => {
  const root = mkdtempSync(path.join(tmpdir(), `ork-preview-scratch-sweep-${process.pid}-`));
  try {
    const now = Date.now();
    const make = (suffix: string, recorded: string | null, age: number) => {
      const target = path.join(root, `${PREVIEW_SCRATCH_PREFIX}${process.pid}-${suffix}`);
      mkdirSync(target);
      if (recorded) writeFileSync(path.join(target, ".ork-preview-owner"), recorded);
      utimesSync(target, (now - age) / 1000, (now - age) / 1000);
      return target;
    };
    const old = PREVIEW_SCRATCH_STALE_MS + 60_000;
    const recycled = make("aB3dE1", "previous-process", old);
    const live = make("aB3dE2", "current-process", old);
    const fresh = make("aB3dE3", "previous-process", 1_000);
    const unknown = make("aB3dE4", null, old);
    const legacyStale = make("aB3dE5", null, LEGACY_PREVIEW_SCRATCH_STALE_MS + old);
    const inaccessible = make("aB3dE6", "unreadable-process", old);

    expect(
      await sweepStalePreviewScratch({
        root,
        now,
        processStartIdentity: () => null,
      }),
    ).toEqual([legacyStale]);
    // The test process is live but did not create the recorded old owner.
    expect(
      (
        await sweepStalePreviewScratch({
          root,
          now,
          processStartIdentity: () => "current-process",
        })
      ).sort(),
    ).toEqual([recycled, inaccessible].sort());
    for (const kept of [live, fresh, unknown]) expect(existsSync(kept)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery checks real process identity and preserves the live backend's scratch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), `ork-preview-scratch-owner-${process.pid}-`));
  const worker = superviseWorker(
    {
      isolation: "process",
      command: process.execPath,
      args: [path.join(import.meta.dir, "fixtures/fake-preview-worker.ts")],
      scratchRoot: root,
    },
    { job: { kind: "mermaid", source: "hang", theme: "light" } } as Parameters<
      typeof superviseWorker
    >[1],
    { workerWallMs: 10000, readinessHardMs: 3000, mermaidRenderMs: 3000, cleanupGraceMs: 0 },
  );
  try {
    const scratch = worker.scratchDir()!;
    expect(readFileSync(path.join(scratch, ".ork-preview-owner"), "utf8")).not.toBe("");
    // The worker is a real live process, but is not the backend that owned
    // this old directory. Its PID must not protect the previous owner's data.
    const recycled = path.join(root, `${PREVIEW_SCRATCH_PREFIX}${worker.workerPid()}-aB3dE9`);
    mkdirSync(recycled);
    writeFileSync(path.join(recycled, ".ork-preview-owner"), "previous-process-start");
    const old = (Date.now() - PREVIEW_SCRATCH_STALE_MS - 60000) / 1000;
    for (const target of [scratch, recycled]) utimesSync(target, old, old);
    expect(await sweepStalePreviewScratch({ root })).toEqual([recycled]);
    expect(existsSync(scratch)).toBe(true);
  } finally {
    worker.cancel();
    expect((await worker.exited).verified).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
