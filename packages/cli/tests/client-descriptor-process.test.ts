import { GatewayTransport } from "../src/client/transport.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createProcessStartReader,
  parseProcStatBootTime,
  parseProcStatStartTicks,
  parsePsLstart,
  readProcessStartTime,
  readLinuxProcessIdentity,
  type ProcessStartSources,
} from "../src/client/process-start.js";
import { awaitServiceConnection } from "../src/client/service-connection.js";
import {
  DESCRIPTOR_START_AFTER_TOLERANCE_MS,
  DESCRIPTOR_START_BEFORE_TOLERANCE_MS,
  descriptorProcessRefusal,
  resolveProfile,
  resolveSavedConnection,
  type ResolvedTarget,
} from "../src/client/targets.js";
import {
  createSandbox,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

// Every descriptor here lives in a fresh temporary sandbox and names either
// this test process or a child it spawned; nothing reads the real data
// directory, its descriptor or its auth file.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sandbox(): Promise<ClientSandbox> {
  const box = await createSandbox();
  cleanups.push(() => box.cleanup());
  return box;
}

async function gateway(): Promise<FakeGateway> {
  const created = await startFakeGateway();
  cleanups.push(() => created.stop());
  return created;
}

/** A process of this user started now: what a reused pid looks like. */
function startChild(): ChildProcess & { pid: number } {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  if (child.pid === undefined) throw new Error("child did not start");
  return child as ChildProcess & { pid: number };
}

async function rewriteDescriptor(dataDir: string, changes: Record<string, unknown>) {
  const file = path.join(dataDir, "backend-instance.json");
  const descriptor = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...descriptor, ...changes }), { mode: 0o600 });
}

async function publishProfile(
  box: ClientSandbox,
  backend: FakeGateway,
  dataDir: string,
  pid: number,
) {
  const runtime = path.join(box.env.ORKESTRATOR_DEV_ROOT!, "profiles", "qa", "runtime");
  await mkdir(runtime, { recursive: true });
  const statusPath = path.join(runtime, "status.json");
  await writeFile(
    statusPath,
    JSON.stringify({
      version: 1,
      profile: "qa",
      flavor: "agent-test",
      electronTitle: "x",
      rendererUrl: "http://127.0.0.1:1",
      logDir: runtime,
      statusPath,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      processStartTimes: {},
      status: "ready",
      dataDir,
      pids: { backend: pid },
      browserUrl: backend.url,
      authFile: path.join(dataDir, "gateway-auth.json"),
    }),
  );
}

const supported = process.platform === "linux" || process.platform === "darwin";
const fiveMinutesAgo = () => new Date(Date.now() - 5 * 60_000).toISOString();

describe("start time parsing", () => {
  test("reads field 22 of /proc/<pid>/stat past a command name with spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
    fields[18] = "123456"; // field 22: the state (field 3) is index 0 after ")"
    expect(parseProcStatStartTicks(`4242 (my (odd) name) S ${fields.join(" ")}`)).toBe(123456);
  });

  test("rejects a malformed /proc/<pid>/stat", () => {
    expect(parseProcStatStartTicks("")).toBeNull();
    expect(parseProcStatStartTicks("4242 (short) S 1 2 3")).toBeNull();
    expect(parseProcStatStartTicks(`4242 (x) S ${"x ".repeat(30)}`)).toBeNull();
  });

  test("reads btime from /proc/stat", () => {
    expect(parseProcStatBootTime("cpu  1 2 3\nbtime 1762300000\nprocesses 9\n")).toBe(1762300000);
    expect(parseProcStatBootTime("cpu  1 2 3\n")).toBeNull();
  });

  test("parses ps lstart as UTC", () => {
    expect(parsePsLstart("Thu Nov  5 16:35:38 2026\n")).toBe(Date.UTC(2026, 10, 5, 16, 35, 38));
    expect(parsePsLstart("Mon Jan 12 03:04:05 2026")).toBe(Date.UTC(2026, 0, 12, 3, 4, 5));
    // macOS 27.2's /bin/ps pads the column with trailing spaces.
    expect(parsePsLstart("Fri Nov  6 05:27:51 2026    \n")).toBe(Date.UTC(2026, 10, 6, 5, 27, 51));
    expect(parsePsLstart("")).toBeNull();
    expect(parsePsLstart("Thu Foo  5 16:35:38 2026")).toBeNull();
    expect(parsePsLstart("5 Nov 2026 16:35:38")).toBeNull();
  });
});

function fakeSources(overrides: Partial<ProcessStartSources>): ProcessStartSources {
  return {
    platform: "linux",
    readText: () => Promise.reject(new Error("unexpected read")),
    runPs: () => Promise.reject(new Error("unexpected ps")),
    ...overrides,
  };
}

describe("process start reader", () => {
  test("Linux combines boot time with the process's start ticks", async () => {
    const fields = Array.from({ length: 50 }, () => "0");
    fields[18] = "12345"; // field 22: 123.45 s after boot at USER_HZ 100
    const reads: string[] = [];
    const read = createProcessStartReader(
      fakeSources({
        platform: "linux",
        readText: async (file) => {
          reads.push(file);
          if (file === "/proc/4242/stat") return `4242 (backend) S ${fields.join(" ")}\n`;
          if (file === "/proc/stat") return "cpu 0\nbtime 1762300000\n";
          throw new Error("unexpected file");
        },
      }),
    );
    expect(await read(4242)).toBe(1762300000 * 1000 + 123450);
    expect(reads).toEqual(["/proc/4242/stat", "/proc/stat"]);
  });

  test("macOS asks ps for the process's lstart", async () => {
    const calls: string[][] = [];
    const read = createProcessStartReader(
      fakeSources({
        platform: "darwin",
        runPs: async (args) => {
          calls.push(args);
          return "Thu Nov  5 16:35:38 2026\n";
        },
      }),
    );
    expect(await read(4242)).toBe(Date.UTC(2026, 10, 5, 16, 35, 38));
    expect(calls).toEqual([["-o", "lstart=", "-p", "4242"]]);
  });

  test("an unreadable start time is null on both platforms", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    for (const sources of [
      fakeSources({ platform: "linux", readText: () => Promise.reject(missing) }),
      fakeSources({ platform: "linux", readText: async () => "garbage" }),
      fakeSources({ platform: "darwin", runPs: () => Promise.reject(new Error("exit 1")) }),
      fakeSources({ platform: "darwin", runPs: async () => "" }),
      // The CLI ships for Linux and macOS only; anything else cannot confirm.
      fakeSources({ platform: "win32", runPs: async () => "Thu Nov  5 16:35:38 2026" }),
    ]) {
      expect(await createProcessStartReader(sources)(4242)).toBeNull();
    }
    expect(await createProcessStartReader(fakeSources({}))(0)).toBeNull();
    expect(await createProcessStartReader(fakeSources({}))(-1)).toBeNull();
  });

  test.skipIf(!supported)("reads a real child's start time on this host", async () => {
    const before = Date.now();
    const child = startChild();
    const started = await readProcessStartTime(child.pid);
    expect(started).not.toBeNull();
    // One-second resolution on both platforms, so allow for truncation.
    expect(started!).toBeGreaterThanOrEqual(before - 2_000);
    expect(started!).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  // BSD ps prints lstart in the caller's locale and zone ("Fr.  6 Nov. ..."
  // under de_DE), so the reader must pin both rather than inherit them.
  test.skipIf(process.platform !== "darwin")(
    "reads a real child's start time whatever the caller's locale and zone",
    async () => {
      const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
      Object.assign(process.env, {
        LC_ALL: "de_DE.UTF-8",
        LANG: "de_DE.UTF-8",
        TZ: "Pacific/Kiritimati",
      });
      try {
        const before = Date.now();
        const child = startChild();
        const started = await readProcessStartTime(child.pid);
        expect(started).not.toBeNull();
        expect(started!).toBeGreaterThanOrEqual(before - 2_000);
        expect(started!).toBeLessThanOrEqual(Date.now() + 1_000);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
});

describe("descriptorProcessRefusal", () => {
  const startedAt = "2026-11-05T12:00:00.000Z";
  const at = Date.parse(startedAt);
  const live = () => true;
  const reader = (value: number | null) => async () => value;

  test("accepts a process that started before the backend wrote startedAt", async () => {
    expect(await descriptorProcessRefusal({ pid: 7, startedAt }, reader(at - 4_000), live)).toBe(
      null,
    );
    expect(
      await descriptorProcessRefusal(
        { pid: 7, startedAt },
        reader(at - DESCRIPTOR_START_BEFORE_TOLERANCE_MS),
        live,
      ),
    ).toBeNull();
  });

  test("accepts a start up to the tolerance after startedAt", async () => {
    expect(
      await descriptorProcessRefusal(
        { pid: 7, startedAt },
        reader(at + DESCRIPTOR_START_AFTER_TOLERANCE_MS),
        live,
      ),
    ).toBeNull();
  });

  test("refuses a pid whose process started after the backend: a reused pid", async () => {
    const reason = await descriptorProcessRefusal(
      { pid: 7, startedAt },
      reader(at + DESCRIPTOR_START_AFTER_TOLERANCE_MS + 1_000),
      live,
    );
    expect(reason).toContain("pid 7 belongs to a process started at");
    expect(reason).toContain("descriptor is stale");
  });

  test("refuses a pid whose process is far older than the backend", async () => {
    expect(
      await descriptorProcessRefusal(
        { pid: 7, startedAt },
        reader(at - DESCRIPTOR_START_BEFORE_TOLERANCE_MS - 1_000),
        live,
      ),
    ).toContain("descriptor is stale");
  });

  test("refuses when the start time cannot be read", async () => {
    expect(await descriptorProcessRefusal({ pid: 7, startedAt }, reader(null), live)).toBe(
      "cannot be confirmed: the start time of process 7 could not be read",
    );
  });

  test("refuses a descriptor whose startedAt is not a time, without reading the process", async () => {
    let reads = 0;
    const reason = await descriptorProcessRefusal(
      { pid: 7, startedAt: "not a time" },
      async () => {
        reads += 1;
        return at;
      },
      live,
    );
    expect(reason).toContain("no valid start time");
    expect(reads).toBe(0);
  });

  test("a dead pid stays stale", async () => {
    expect(await descriptorProcessRefusal({ pid: 7, startedAt }, reader(at), () => false)).toBe(
      "is not running as your user (its descriptor is stale)",
    );
  });
});

describe.skipIf(!supported)("commands refuse a reused descriptor pid", () => {
  test("a descriptor naming this live backend process is still used", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    const added = await box.run(["--json", "connection", "add", "local", "--data-dir", dataDir]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out).result.verified).toBe(true);
    backend.requests.length = 0;
    const listed = await box.run(["--json", "--connection", "local", "project", "list"]);
    expect(listed.code).toBe(0);
    expect(backend.requests.length).toBeGreaterThan(0);
  });

  test("connection add refuses a pid now held by a later process and contacts nothing", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const child = startChild();
    const dataDir = await box.publishDescriptor(backend, { pid: child.pid });
    await rewriteDescriptor(dataDir, { startedAt: fiveMinutesAgo() });
    const result = await box.run(["--json", "connection", "add", "local", "--data-dir", dataDir]);
    expect(result.code).toBe(4);
    const error = JSON.parse(result.out).error;
    expect(error.code).toBe("connection-failed");
    expect(error.message).toContain("descriptor is stale");
    expect(backend.requests).toHaveLength(0);
  });

  test("a saved connection stops once its pid is reused", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    expect(
      (await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default"])).code,
    ).toBe(0);
    // The backend died; a later process of this user took its pid.
    const child = startChild();
    await rewriteDescriptor(dataDir, { pid: child.pid, startedAt: fiveMinutesAgo() });
    backend.requests.length = 0;
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("descriptor is stale");
    expect(backend.requests).toHaveLength(0);
  });

  test("a profile whose backend pid was reused is refused without falling back", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const child = startChild();
    const dataDir = await box.publishDescriptor(backend, { pid: child.pid });
    await rewriteDescriptor(dataDir, { startedAt: fiveMinutesAgo() });
    await publishProfile(box, backend, dataDir, child.pid);
    const result = await box.run(["--json", "--profile", "qa", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("descriptor is stale");
    expect(backend.requests).toHaveLength(0);
  });
});

describe("the start time is checked before the token is read", () => {
  test("an unreadable start time refuses before the credential file is opened", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    // Without a credential file, reaching readToken would fail differently.
    await rm(path.join(dataDir, "gateway-auth.json"));
    const saved = {
      kind: "descriptor" as const,
      descriptorPath: path.join(dataDir, "backend-instance.json"),
      addedAt: new Date().toISOString(),
    };
    await expect(resolveSavedConnection("local", saved, async () => null)).rejects.toMatchObject({
      code: "connection-failed",
      message: `The backend for connection 'local' cannot be confirmed: the start time of process ${process.pid} could not be read`,
    });
    const matching = await resolveSavedConnection("local", saved, async () => Date.now() - 1_000);
    expect(matching.baseUrl).toBe(backend.url);
    expect(backend.requests).toHaveLength(0);
  });

  test("service start never takes a token from a descriptor whose process it cannot confirm", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    let clock = 0;
    const options = {
      timeoutMs: 1_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
    expect(
      await awaitServiceConnection(dataDir, null, { ...options, readStart: async () => null }),
    ).toBeNull();
    clock = 0;
    const later = Date.now() + DESCRIPTOR_START_AFTER_TOLERANCE_MS + 60_000;
    expect(
      await awaitServiceConnection(dataDir, null, { ...options, readStart: async () => later }),
    ).toBeNull();
    clock = 0;
    const connection = await awaitServiceConnection(dataDir, null, {
      ...options,
      readStart: async () => Date.now() - 1_000,
    });
    expect(connection?.token).not.toBeNull();
  });
});

describe("cached target process binding", () => {
  for (const changed of [null, Date.now() + 120_000]) {
    for (const retry of [false, true]) {
      test(`blocks ${retry ? "401 retry" : "next request"} after process becomes ${changed === null ? "unreadable" : "reused"}`, async () => {
        const box = await sandbox();
        const backend = await gateway();
        const dataDir = await box.publishDescriptor(backend);
        let start: number | null = Date.now();
        const target = await resolveSavedConnection(
          "local",
          {
            kind: "descriptor",
            descriptorPath: path.join(dataDir, "backend-instance.json"),
            addedAt: new Date().toISOString(),
          },
          async () => start,
        );
        let requests = 0;
        const transport = new GatewayTransport(target, async () => {
          requests++;
          start = changed;
          // If the guard is bypassed, token reading fails with auth-failed.
          await rm(path.join(dataDir, "gateway-auth.json"));
          return new Response("{}", { status: retry ? 401 : 200 });
        });
        if (!retry) await transport.invoke("test", {}, { mutation: false });
        await expect(transport.invoke("test", {}, { mutation: false })).rejects.toMatchObject({
          code: "connection-failed",
        });
        expect(requests).toBe(1);
      });
    }
  }
});

describe("a target follows its backend through a restart", () => {
  async function restartable(
    options: { installationAfter?: string; kind?: "connection" | "profile" } = {},
  ) {
    const box = await sandbox();
    const first = await gateway();
    const second = await gateway();
    const dataDir = await box.publishDescriptor(first);
    const descriptorFile = path.join(dataDir, "backend-instance.json");
    let start: number | null = Date.now();
    let generation = 1;
    const readStart = async () => start;
    let target: ResolvedTarget;
    if (options.kind === "profile") {
      // The profile's backend pid is this process, as in the descriptor.
      await publishProfile(box, first, dataDir, process.pid);
      target = await resolveProfile("qa", box.env, readStart);
    } else {
      target = await resolveSavedConnection(
        "local",
        { kind: "descriptor", descriptorPath: descriptorFile, addedAt: new Date().toISOString() },
        readStart,
      );
    }
    const transport = new GatewayTransport(target);
    return {
      first,
      second,
      target,
      transport,
      descriptorFile,
      request: () => transport.invoke("test", {}, { mutation: false }),
      /** The current process exits; nothing has replaced it yet. */
      exit() {
        start = Date.now() + 120_000 * generation;
      },
      /** Its successor (same pid here, a later start) publishes its descriptor. */
      async publishSuccessor(next: FakeGateway = second) {
        generation += 1;
        await rewriteDescriptor(dataDir, {
          installationId: options.installationAfter ?? "install-a",
          generation: `gen-${generation}`,
          startedAt: new Date(start!).toISOString(),
          url: next.url,
        });
      },
    };
  }

  test("the next request reaches the successor of the same installation", async () => {
    const backend = await restartable();
    await backend.request();
    backend.exit();
    // Until the successor publishes, the original refusal stands: a --wait
    // observer reads this as "the backend is away" and keeps waiting.
    await expect(backend.request()).rejects.toMatchObject({ code: "connection-failed" });
    await backend.publishSuccessor();
    await backend.request();
    expect(backend.first.requests).toHaveLength(1);
    expect(backend.second.requests).toHaveLength(1);
    expect(backend.target.baseUrl).toBe(backend.second.url);
    expect(backend.target.identity.generation).toBe("gen-2");
    expect(backend.target.descriptorGeneration).toBe("gen-2");
  });

  test("a second restart is followed through the successor's own target", async () => {
    const backend = await restartable();
    const third = await gateway();
    await backend.request();
    backend.exit();
    await backend.publishSuccessor();
    await backend.request();
    expect(backend.target.baseUrl).toBe(backend.second.url);
    // The successor exits in turn: its refusal stands until the next publishes.
    backend.exit();
    await expect(backend.request()).rejects.toMatchObject({ code: "connection-failed" });
    expect(backend.second.requests).toHaveLength(1);
    await backend.publishSuccessor(third);
    await backend.request();
    expect(backend.first.requests).toHaveLength(1);
    expect(backend.second.requests).toHaveLength(1);
    expect(third.requests).toHaveLength(1);
    expect(backend.target.baseUrl).toBe(third.url);
    expect(backend.target.identity.generation).toBe("gen-3");
    expect(backend.target.descriptorGeneration).toBe("gen-3");
  });

  test("a different installation at the same data directory is refused", async () => {
    const backend = await restartable({ installationAfter: "install-b" });
    backend.exit();
    await backend.publishSuccessor();
    await expect(backend.request()).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(backend.second.requests).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")(
    "a successor descriptor that fails the trust checks is not followed and gets no token",
    async () => {
      const backend = await restartable();
      backend.exit();
      await backend.publishSuccessor();
      // Readable by other users: refused, so the original refusal stands.
      await chmod(backend.descriptorFile, 0o644);
      await expect(backend.request()).rejects.toMatchObject({ code: "connection-failed" });
      // A symbolic link in its place, even to a trusted copy, is refused too.
      const copy = `${backend.descriptorFile}.real`;
      await chmod(backend.descriptorFile, 0o600);
      await rename(backend.descriptorFile, copy);
      await symlink(copy, backend.descriptorFile);
      await expect(backend.request()).rejects.toMatchObject({ code: "connection-failed" });
      expect(backend.second.requests).toHaveLength(0);
      expect(backend.target.baseUrl).toBe(backend.first.url);
      // Once it is a trusted file again, the successor is followed.
      await rm(backend.descriptorFile);
      await rename(copy, backend.descriptorFile);
      await backend.request();
      expect(backend.second.requests).toHaveLength(1);
    },
  );

  test("a profile target follows the successor and refuses another installation", async () => {
    const backend = await restartable({ kind: "profile" });
    await backend.request();
    backend.exit();
    await expect(backend.request()).rejects.toMatchObject({ code: "connection-failed" });
    await backend.publishSuccessor();
    await backend.request();
    expect(backend.first.requests).toHaveLength(1);
    expect(backend.second.requests).toHaveLength(1);
    expect(backend.target.baseUrl).toBe(backend.second.url);
    expect(backend.target.identity.kind).toBe("profile");

    const impostor = await restartable({ kind: "profile", installationAfter: "install-b" });
    impostor.exit();
    await impostor.publishSuccessor();
    await expect(impostor.request()).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(impostor.second.requests).toHaveLength(0);
  });
});

test.skipIf(process.platform !== "linux")(
  "Linux binding ignores shifted btime and detects changed ticks and boot ID",
  async () => {
    const boot = "11111111-1111-1111-1111-111111111111";
    let bootId = boot;
    let ticks = "12345";
    let btime = 1762300000;
    const readText = async (file: string) => {
      if (file.endsWith("boot_id")) return bootId;
      if (file === "/proc/stat") return `btime ${btime}`;
      const fields = Array.from({ length: 50 }, () => "0");
      fields[18] = ticks;
      return `4242 (backend) S ${fields.join(" ")}`;
    };
    const first = await readLinuxProcessIdentity(4242, readText);
    expect(first).toBe(`${boot}:12345`);
    btime += 3600;
    expect(await readLinuxProcessIdentity(4242, readText)).toBe(first);
    btime -= 7200;
    expect(await readLinuxProcessIdentity(4242, readText)).toBe(first);
    ticks = "12346";
    expect(await readLinuxProcessIdentity(4242, readText)).not.toBe(first);
    ticks = "12345";
    bootId = "22222222-2222-2222-2222-222222222222";
    expect(await readLinuxProcessIdentity(4242, readText)).not.toBe(first);
    expect(await readLinuxProcessIdentity(4242, async () => "garbage")).toBeNull();
    expect(
      await readLinuxProcessIdentity(4242, async () => {
        throw new Error("gone");
      }),
    ).toBeNull();
  },
);

test.skipIf(process.platform !== "linux")(
  "Linux descriptors require stable identity and survive wall-clock shifts",
  async () => {
    const identity = await readLinuxProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    for (const startedAt of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      expect(
        await descriptorProcessRefusal({ pid: process.pid, startedAt, processIdentity: identity! }),
      ).toBeNull();
    }
    // Every backend before #1848 (v2.21.0 included) writes no identity. The
    // refusal stays and names the explicit-URL route the version-compatibility
    // register records (to-do 7120 (retired) task 3).
    const refusal = await descriptorProcessRefusal({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    expect(refusal).toContain("publishes no Linux process identity");
    expect(refusal).toContain("2.36.4-beta");
    expect(refusal).toContain("--url <its URL> --credential-file");
    expect(refusal).toContain("gateway-auth.json");
    expect(
      await descriptorProcessRefusal({
        pid: process.pid,
        startedAt: "",
        processIdentity: identity + "1",
      }),
    ).toContain("descriptor is stale");
  },
);
