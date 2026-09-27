import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ContainerLogService,
  LOG_LIMITS,
  recordCut,
} from "../../../apps/backend/src/core/container-log-service";
import { boundedBackgroundLaunch } from "../../../apps/backend/src/core/container-log-bounds";

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

  test("the writer rotates by size, keeps N files and cuts oversize lines", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ork-log-writer-"));
    try {
      const file = path.join(dir, "bridge.log");
      const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${"y".repeat(50)}`);
      lines.splice(10, 0, "z".repeat(50_000));
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          path.resolve(import.meta.dir, "../../../docker/orkestrator-log-writer.sh"),
          file,
          "32768",
          "3",
        ],
        stdin: Buffer.from(lines.join("\n") + "\n"),
      });
      expect(result.exitCode).toBe(0);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(["bridge.log", "bridge.log.1", "bridge.log.2"]);
      for (const name of files) {
        expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(32768);
        expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(file, "utf8").trim().split("\n").at(-1)).toContain("line 3999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
