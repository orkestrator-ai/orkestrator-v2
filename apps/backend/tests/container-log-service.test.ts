import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainerLogService, LOG_LIMITS, recordCut } from "../src/core/container-log-service";
import { boundedBackgroundLaunch } from "../src/core/container-log-bounds";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill() {
    this.killed = true;
    this.exitCode = 143;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 143);
    return true;
  }
}

function harness() {
  const children: FakeChild[] = [];
  let now = 1_000_000;
  const service = new ContainerLogService(
    (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
    () => now,
  );
  return {
    service,
    children,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const services: ContainerLogService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.shutdown();
});

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("container log service", () => {
  test("shares one follower per container and stops it after the last close", async () => {
    const { service, children } = harness();
    services.push(service);
    const a = service.open("container-1");
    const b = service.open("container-1");
    expect(children).toHaveLength(1);
    expect(a.sourceId).toBe(b.sourceId);
    service.close(a.subscriptionId);
    service.close(b.subscriptionId);
    expect(children[0]!.killed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, LOG_LIMITS.idleGraceMs + 50));
    expect(children[0]!.killed).toBe(true);
    expect(service.followerCount()).toBe(0);
  }, 10_000);

  test("splits huge lines and keeps a multibyte character split across chunks intact", async () => {
    const { service, children } = harness();
    services.push(service);
    const { subscriptionId, sourceId, cursor } = service.open("container-1");
    const euro = Buffer.from("€\n");
    children[0]!.stdout.write(euro.subarray(0, 1));
    children[0]!.stdout.write(euro.subarray(1));
    children[0]!.stdout.write("x".repeat(LOG_LIMITS.recordBytes * 2 + 10) + "\n");
    await tick();
    const read = service.read(subscriptionId, sourceId, cursor);
    expect(read.kind).toBe("records");
    if (read.kind !== "records") return;
    expect(read.records[0]!.text).toBe("€\n");
    for (const record of read.records) {
      expect(Buffer.byteLength(record.text)).toBeLessThanOrEqual(LOG_LIMITS.recordBytes);
    }
    expect(read.records.map((record) => record.text).join("")).toBe(
      "€\n" + "x".repeat(LOG_LIMITS.recordBytes * 2 + 10) + "\n",
    );
  });

  test("a cursor older than the ring or from another source is an explicit gap", async () => {
    const { service, children } = harness();
    services.push(service);
    const { subscriptionId, sourceId } = service.open("container-1");
    for (let index = 0; index < LOG_LIMITS.ringRecords + 50; index += 1) {
      children[0]!.stdout.write(`line ${index}\n`);
    }
    await tick();
    expect(service.read(subscriptionId, sourceId, 0)).toMatchObject({ kind: "gap" });
    expect(service.read(subscriptionId, "another-source", 60)).toMatchObject({ kind: "gap" });
    const recent = service.read(subscriptionId, sourceId, LOG_LIMITS.ringRecords + 40);
    expect(recent).toMatchObject({ kind: "records" });
  });

  test("records are bounded in bytes, not characters, and never split a surrogate pair", async () => {
    const { service, children } = harness();
    services.push(service);
    const { subscriptionId, sourceId, cursor } = service.open("container-1");
    // Three-byte characters: a character count at the byte limit would triple it.
    const wide = "€".repeat(LOG_LIMITS.recordBytes) + "\n";
    children[0]!.stdout.write(wide);
    children[0]!.stdout.write("😀".repeat(LOG_LIMITS.recordBytes) + "\n");
    await tick();
    const read = service.read(subscriptionId, sourceId, cursor);
    if (read.kind !== "records") throw new Error("expected records");
    let all = read.records;
    let next = read.cursor;
    while (true) {
      const more = service.read(subscriptionId, sourceId, next);
      if (more.kind !== "records" || more.records.length === 0) break;
      all = all.concat(more.records);
      next = more.cursor;
    }
    for (const record of all) {
      expect(Buffer.byteLength(record.text)).toBeLessThanOrEqual(LOG_LIMITS.recordBytes);
      expect(record.text).not.toContain("\uFFFD");
      const last = record.text.charCodeAt(record.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(all.map((record) => record.text).join("")).toBe(
      wide + "😀".repeat(LOG_LIMITS.recordBytes) + "\n",
    );
    expect(recordCut("ab😀", 4)).toBe(2);
  });

  test("a gap carries the newest bounded tail; a stopped container's restart is a new source", async () => {
    const { service, children } = harness();
    services.push(service);
    const first = service.open("container-1");
    for (let index = 0; index < LOG_LIMITS.ringRecords + 10; index += 1) {
      children[0]!.stdout.write(`line ${index}\n`);
    }
    await tick();
    const gap = service.read(first.subscriptionId, first.sourceId, 0);
    if (gap.kind !== "gap") throw new Error("expected a gap");
    expect(gap.records.length).toBeGreaterThan(0);
    expect(gap.records.at(-1)!.text).toBe(`line ${LOG_LIMITS.ringRecords + 9}\n`);
    expect(gap.cursor).toBe(gap.records.at(-1)!.seq);
    // The container stops: the follower ends while a subscriber is still open.
    children[0]!.emit("close", 0);
    const reopened = service.open("container-1");
    expect(children).toHaveLength(2);
    expect(reopened.sourceId).not.toBe(first.sourceId);
    // The earlier subscriber still sees its own source as ended.
    expect(service.read(first.subscriptionId, first.sourceId, gap.cursor)).toMatchObject({
      ended: true,
    });
  });

  test("a lapsed lease releases the subscription; limits refuse excess followers", async () => {
    const { service, advance } = harness();
    services.push(service);
    const { subscriptionId, sourceId, cursor } = service.open("container-1");
    advance(LOG_LIMITS.leaseMs + 1);
    service.sweepLeases();
    expect(() => service.read(subscriptionId, sourceId, cursor)).toThrow("expired");
    // The first follower is still in its idle grace, so it counts.
    for (let index = 0; index < LOG_LIMITS.maxFollowers - 1; index += 1) {
      service.open(`c-${index}`);
    }
    expect(() => service.open("one-too-many")).toThrow(
      "ContainerLifecycleError:resource-exhausted",
    );
  });

  test("a follower that exits reports the source ended; shutdown stops the rest", async () => {
    const { service, children } = harness();
    services.push(service);
    const first = service.open("container-1");
    service.open("container-2");
    children[0]!.emit("close", 0);
    expect(service.read(first.subscriptionId, first.sourceId, first.cursor)).toMatchObject({
      ended: true,
    });
    service.shutdown();
    expect(children[1]!.killed).toBe(true);
    expect(() => service.open("container-3")).toThrow("resource-exhausted");
  });
});

describe("bounded bridge output", () => {
  test("launch uses the rotating writer when the image has it, else the plain redirect", () => {
    const shell = boundedBackgroundLaunch("bun /opt/x/index.js", "/tmp/x.log");
    expect(shell).toContain("if [ -x /usr/local/bin/orkestrator-log-writer ]; then");
    expect(shell).toContain(
      "setsid sh -c 'bun /opt/x/index.js 2>&1 | /usr/local/bin/orkestrator-log-writer /tmp/x.log'",
    );
    expect(shell).toContain("setsid bun /opt/x/index.js > /tmp/x.log 2>&1 &");
  });

  const WRITER = path.resolve(import.meta.dir, "../../../docker/orkestrator-log-writer.sh");

  function withWriterDir(run: (dir: string, file: string) => void | Promise<void>) {
    return async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ork-log-writer-"));
      try {
        await run(dir, path.join(dir, "bridge.log"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  function runWriter(file: string, input: string | Buffer, ...sizes: string[]) {
    return Bun.spawnSync({
      cmd: ["bash", WRITER, file, ...sizes],
      stdin: typeof input === "string" ? Buffer.from(input) : input,
    });
  }

  async function waitForContent(file: string, expected: string): Promise<string> {
    // Well inside the test's own timeout, so a miss fails on the content.
    const deadline = Date.now() + 3_000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = readFileSync(file, "utf8");
      } catch {
        content = "";
      }
      if (content === expected) break;
      await Bun.sleep(25);
    }
    return content;
  }

  test("the writer handles rotation failures, output errors, signals and fallback", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        path.resolve(import.meta.dir, "../../../docker/tests/log-writer-test.sh"),
        WRITER,
      ],
      timeout: 20_000,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("log writer regression checks: passed");
  }, 25_000);

  test(
    "the writer writes each line while its producer's pipe stays open",
    withWriterDir(async (_dir, file) => {
      // A bridge prints a line now and then and never closes its output. A
      // writer built from pipe tools lost this to their buffering: Debian's
      // mawk held its input without `-W interactive`, and Rust coreutils'
      // `fold` (Ubuntu 26.04) held its output whatever `stdbuf` asked.
      const writer = Bun.spawn({ cmd: ["bash", WRITER, file], stdin: "pipe" });
      try {
        writer.stdin.write("first line\n");
        writer.stdin.flush();
        expect(await waitForContent(file, "first line\n")).toBe("first line\n");
        // A line that arrives in pieces is written once its newline does.
        writer.stdin.write("second ");
        writer.stdin.flush();
        await Bun.sleep(100);
        expect(readFileSync(file, "utf8")).toBe("first line\n");
        writer.stdin.write("line\n");
        writer.stdin.flush();
        expect(await waitForContent(file, "first line\nsecond line\n")).toBe(
          "first line\nsecond line\n",
        );
      } finally {
        writer.stdin.end();
        await writer.exited;
      }
    }),
    10_000,
  );

  test(
    "the writer ends an unterminated last line and appends to an existing file",
    withWriterDir((_dir, file) => {
      expect(runWriter(file, "one\ntwo").exitCode).toBe(0);
      expect(runWriter(file, "three\n").exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }),
  );

  test(
    "the writer stays bounded on output without a single newline",
    withWriterDir((dir, file) => {
      const result = runWriter(file, Buffer.alloc(3 * 1024 * 1024, "n"), "32768", "2");
      expect(result.exitCode).toBe(0);
      for (const name of readdirSync(dir)) {
        expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(32768);
      }
      expect(readdirSync(dir).sort()).toEqual(["bridge.log", "bridge.log.1"]);
    }),
  );

  test(
    "the writer splits a line at 64 KiB before cutting it to the file size",
    withWriterDir((_dir, file) => {
      const exact = "a".repeat(65536);
      const long = "b".repeat(65536 + 10);
      expect(runWriter(file, `${exact}\n${long}\n`, "1048576").exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(
        `${exact}\n${"b".repeat(65536)}\n${"b".repeat(10)}\n`,
      );
    }),
  );

  test(
    "the writer rotates by size, keeps N files and cuts oversize lines",
    withWriterDir((dir, file) => {
      const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${"y".repeat(50)}`);
      lines.splice(10, 0, "z".repeat(50_000));
      const result = runWriter(file, lines.join("\n") + "\n", "32768", "3");
      expect(result.exitCode).toBe(0);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(["bridge.log", "bridge.log.1", "bridge.log.2"]);
      for (const name of files) {
        expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(32768);
        expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(file, "utf8").trim().split("\n").at(-1)).toContain("line 3999");
    }),
  );

  test(
    "the writer cuts a line larger than a whole file and marks the cut",
    withWriterDir((_dir, file) => {
      expect(runWriter(file, `${"z".repeat(200)}\nafter\n`, "100").exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(`${"z".repeat(68)} [line truncated]\nafter\n`);
    }),
  );

  test(
    "the writer counts an existing file towards its size and keeps one file in place",
    withWriterDir((dir, file) => {
      expect(runWriter(file, `${"x".repeat(90)}\n`, "100", "1").exitCode).toBe(0);
      expect(runWriter(file, "next line\n", "100", "1").exitCode).toBe(0);
      expect(readdirSync(dir)).toEqual(["bridge.log"]);
      expect(readFileSync(file, "utf8")).toBe("next line\n");
    }),
  );

  test(
    "the writer drains its input to the end when it cannot write the file",
    withWriterDir((dir) => {
      // A producer writing into a closed pipe would die of SIGPIPE.
      const result = runWriter(
        path.join(dir, "missing", "bridge.log"),
        Buffer.alloc(1024 * 1024, "line\n"),
      );
      expect(result.exitCode).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    }),
  );
});

describe("bounded log tails", () => {
  test("keeps the end within the byte bound and marks the cut", async () => {
    const { boundContainerLogTail, CONTAINER_LOG_TRUNCATED_MARKER } =
      await import("../src/core/commands-registry-docker");
    expect(boundContainerLogTail("short\n", 64)).toBe("short\n");
    const long = "€".repeat(100) + "tail\n";
    const bounded = boundContainerLogTail(long, 64);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(64);
    expect(bounded.startsWith(CONTAINER_LOG_TRUNCATED_MARKER)).toBe(true);
    expect(bounded.endsWith("tail\n")).toBe(true);
    expect(bounded).not.toContain("�");
  });
});
