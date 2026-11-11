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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LEGACY_PREVIEW_SCRATCH_STALE_MS,
  PREVIEW_SCRATCH_PREFIX,
  PREVIEW_SCRATCH_STALE_MS,
  runDocker,
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

function fakeDocker(body: string): { command: string; remove: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "ork-preview-fake-docker-"));
  const command = path.join(directory, "docker");
  writeFileSync(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { command, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

const dockerCases: Array<{
  name: string;
  body: string;
  timeoutMs?: number;
  code: number | null;
  stdout: string;
}> = [
  { name: "a success returns stdout", body: `printf '%s' "$*"`, code: 0, stdout: "ps -a" },
  {
    name: "stderr stays out of stdout",
    body: "echo noise >&2; printf out",
    code: 0,
    stdout: "out",
  },
  {
    name: "a failure keeps its code and stdout",
    body: "printf out; exit 3",
    code: 3,
    stdout: "out",
  },
  {
    name: "a signal death has no code",
    body: "printf out; kill -KILL $$",
    code: null,
    stdout: "out",
  },
  {
    name: "a timeout has no code regardless of shell startup time",
    body: "printf out; exec sleep 30",
    timeoutMs: 100,
    code: null,
    stdout: "out",
  },
  {
    name: "a client ignoring SIGTERM still stops at its timeout",
    body: "trap '' TERM; printf out; sleep 30 & wait; sleep 30",
    timeoutMs: 100,
    code: null,
    stdout: "out",
  },
];

for (const { name, body, timeoutMs, code, stdout } of dockerCases) {
  test(`runDocker: ${name}`, async () => {
    const docker = fakeDocker(body);
    try {
      const result = await runDocker(docker.command, ["ps", "-a"], timeoutMs);
      expect(result.code).toBe(code);
      // Deadline tests must not require the shell to start before termination.
      if (timeoutMs === undefined) expect(result.stdout).toBe(stdout);
    } finally {
      docker.remove();
    }
  });
}

test("runDocker: a Docker client that cannot start has no code and no output", async () => {
  expect(await runDocker("ork-no-such-docker-6060", ["ps"])).toEqual({ code: null, stdout: "" });
});

test("runDocker: returns the start of a long stdout without failing the command", async () => {
  const docker = fakeDocker(`head -c ${256 * 1024} /dev/zero | tr '\\0' x`);
  try {
    expect(await runDocker(docker.command, ["ps"])).toEqual({
      code: 0,
      stdout: "x".repeat(64 * 1024),
    });
  } finally {
    docker.remove();
  }
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`runDocker: accepts exactly the 50 MiB ${stream} bound`, async () => {
    const docker = fakeDocker(
      `head -c ${50 * 1024 * 1024} /dev/zero ${stream === "stderr" ? ">&2" : ""}`,
    );
    try {
      const result = await runDocker(docker.command, ["ps"], 5000);
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBe(stream === "stdout" ? 64 * 1024 : 0);
    } finally {
      docker.remove();
    }
  });
  test(`runDocker: rejects successful exit beyond the 50 MiB ${stream} bound`, async () => {
    const docker = fakeDocker(
      `printf prefix; head -c ${50 * 1024 * 1024 + 1} /dev/zero ${stream === "stderr" ? ">&2" : ""}`,
    );
    try {
      const result = await runDocker(docker.command, ["ps"], 0);
      expect(result.code).toBeNull();
      expect(result.stdout.startsWith("prefix")).toBe(true);
      expect(result.stdout.length).toBe(stream === "stdout" ? 64 * 1024 : 6);
    } finally {
      docker.remove();
    }
  });
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`runDocker: kills an overflowing ${stream} writer with no command deadline`, async () => {
    const docker = fakeDocker(
      `head -c ${50 * 1024 * 1024 + 1} /dev/zero ${stream === "stderr" ? ">&2" : ""}; exec sleep 30`,
    );
    try {
      // No command deadline: a null code must come from overflow termination,
      // rather than a timeout. The test watchdog catches a failure to terminate.
      expect((await runDocker(docker.command, ["ps"], 0)).code).toBeNull();
    } finally {
      docker.remove();
    }
  });
}

/** Whether `pid` is a running process (a zombie awaiting its reaper counts as gone). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

test("a fake worker whose launcher has died exits with its grandchild (0248)", async () => {
  // A killed or timed-out test process never reaps the detached workers it
  // started; one `hang` worker outlived its test by 13 hours. The launcher
  // here is a shell that waits for the `launched` line, so the worker has
  // recorded it as its parent, and then exits as a killed test would.
  const dir = mkdtempSync(path.join(tmpdir(), "ork-fake-orphan-"));
  const pids: number[] = [];
  try {
    const job = path.join(dir, "job.json");
    const out = path.join(dir, "out.ndjson");
    writeFileSync(job, JSON.stringify({ job: { kind: "mermaid", source: "spawn-child" } }));
    const launcher = spawnSync(
      "sh",
      [
        "-c",
        '"$0" "$1" <"$2" >"$3" 2>/dev/null & echo $!; while [ ! -s "$3" ]; do sleep 0.05; done',
        process.execPath,
        path.join(import.meta.dir, "fixtures/fake-preview-worker.ts"),
        job,
        out,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    const worker = Number(launcher.stdout.trim());
    expect(worker).toBeGreaterThan(0);
    pids.push(worker);
    const launched = JSON.parse(readFileSync(out, "utf8").split("\n")[0]!) as {
      browserPid: number;
    };
    expect(launched.browserPid).toBeGreaterThan(0);
    pids.push(launched.browserPid);

    const deadline = Date.now() + 10_000;
    while (pids.some(isRunning) && Date.now() < deadline) await Bun.sleep(50);
    expect(pids.filter(isRunning)).toEqual([]);
  } finally {
    // Only processes this test started, by the PIDs it recorded.
    for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
