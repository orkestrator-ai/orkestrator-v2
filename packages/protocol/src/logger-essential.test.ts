import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  configureLogger,
  createLogger,
  emitLogRecord,
  formatLogError,
  parseLogRecordLine,
  resetLogger,
  tryWriteLog,
  type LogOutput,
  type LogRecord,
} from "./logger.js";

let outputs: LogOutput[];
let offered: LogRecord[];

beforeEach(() => {
  outputs = [];
  offered = [];
  configureLogger({ sink: (output) => void outputs.push(output) });
});

afterEach(resetLogger);

const owner = () => configureLogger({ essentialSink: (record) => void offered.push(record) });
const docker = createLogger("docker");

describe("the process that owns the file", () => {
  beforeEach(owner);

  test("an essential entry reaches both the normal log and the essential sink", () => {
    docker.warn("writer-lease.lost", { reason: "reclaimed" });
    expect(outputs).toHaveLength(1);
    expect(offered.map((record) => record.event)).toEqual(["writer-lease.lost"]);
  });

  test("an error reaches it whatever its event, and a routine warn does not", () => {
    docker.error("login-keeper.pass-failed");
    docker.warn("login-keeper.pass-failed");
    expect(offered).toHaveLength(1);
    expect(outputs).toHaveLength(2);
  });

  test("no level or area setting can switch an essential event off", () => {
    configureLogger({ level: "error", areaLevels: { docker: "error", backend: "error" } });
    docker.warn("writer-lease.lost", { reason: "reclaimed" });
    createLogger("backend").info("starting", { version: "1.2.3" });
    expect(outputs).toEqual([]);
    expect(offered.map((record) => record.event)).toEqual(["writer-lease.lost", "starting"]);
    expect(offered[1]?.fields).toEqual({ version: "1.2.3" });
  });

  test("a level still decides everything that is not essential", () => {
    configureLogger({ level: "error" });
    docker.warn("login-keeper.pass-failed");
    expect(offered).toEqual([]);
    expect(outputs).toEqual([]);
  });

  test("a filtered call in an area with no essential event builds nothing", () => {
    const build = mock(() => ({}));
    createLogger("updater").debug("check.failed", build);
    createLogger("docker").debug("login-keeper.pass-failed", build);
    expect(build).not.toHaveBeenCalled();
    expect(offered).toEqual([]);
  });

  test("tryWriteLog's filter does not switch an essential event off", () => {
    configureLogger({ level: "error" });
    expect(tryWriteLog("warn", "docker", "writer-lease.lost", { reason: "unreadable" })).toBe(
      false,
    );
    expect(offered.map((record) => record.event)).toEqual(["writer-lease.lost"]);
    expect(outputs).toEqual([]);
  });

  test("a throttled essential event is still offered while its level is off", () => {
    configureLogger({ level: "error" });
    createLogger("process").throttled("warn", "rejection.unhandled", {
      kind: "TypeError",
      fields: { kind: "TypeError" },
    });
    expect(outputs).toEqual([]);
    expect(offered.map((record) => record.event)).toEqual(["rejection.unhandled"]);
  });

  test("a sink that throws never reaches the caller", () => {
    configureLogger({
      essentialSink: () => {
        throw new Error("disk on fire");
      },
    });
    expect(() => docker.error("login-keeper.pass-failed")).not.toThrow();
    configureLogger({ level: "error" });
    expect(() => docker.warn("writer-lease.lost")).not.toThrow();
    expect(outputs).toHaveLength(1);
  });

  test("a repeating fault offers its first line and a summary, not every repeat", () => {
    const failing = createLogger("process");
    const report = () =>
      failing.throttled("error", "rejection.unhandled", {
        error: new TypeError("boom"),
        fields: () => ({ error: formatLogError(new TypeError("boom"), { message: false }) }),
      });
    for (let index = 0; index < 500; index += 1) report();
    expect(offered).toHaveLength(1);
    expect(offered[0]?.event).toBe("rejection.unhandled");
  });
});

describe("a process that relays", () => {
  beforeEach(() => {
    configureLogger({ format: "json", relayEssential: true });
  });

  test("an entry its level allows crosses as an ordinary record", () => {
    docker.warn("writer-lease.lost", { reason: "reclaimed" });
    expect(parseLogRecordLine(outputs[0]!.line)?.essentialOnly).toBeUndefined();
  });

  test("an essential entry its level filtered crosses marked, and nothing else does", () => {
    configureLogger({ level: "error" });
    docker.warn("writer-lease.lost", { reason: "reclaimed" });
    docker.warn("login-keeper.pass-failed");
    expect(outputs).toHaveLength(1);
    const parsed = parseLogRecordLine(outputs[0]!.line);
    expect(parsed?.essentialOnly).toBe(true);
    expect(parsed?.fields).toEqual({ reason: "reclaimed" });
  });

  test("a process that neither owns nor relays drops it", () => {
    configureLogger({ level: "error", relayEssential: false });
    docker.warn("writer-lease.lost");
    expect(outputs).toEqual([]);
  });
});

describe("the relay's far end", () => {
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({
      orklog: 1,
      ts: "2026-11-04T10:00:00.000Z",
      level: "warn",
      area: "docker",
      event: "writer-lease.lost",
      ...extra,
    });

  test("a marked record goes to the essential log only", () => {
    owner();
    emitLogRecord(parseLogRecordLine(line({ essentialOnly: true }))!);
    expect(outputs).toEqual([]);
    expect(offered).toHaveLength(1);
  });

  test("a middle hop passes it on, still marked", () => {
    configureLogger({ format: "json", relayEssential: true });
    emitLogRecord(parseLogRecordLine(line({ essentialOnly: true }))!);
    expect(parseLogRecordLine(outputs[0]!.line)?.essentialOnly).toBe(true);
  });

  test("an unmarked record is written and offered as usual", () => {
    owner();
    emitLogRecord(parseLogRecordLine(line({}))!);
    expect(outputs).toHaveLength(1);
    expect(offered).toHaveLength(1);
  });

  test("an imitation cannot hide an event the essential log does not take", () => {
    const parsed = parseLogRecordLine(
      line({ event: "login-keeper.pass-failed", essentialOnly: true }),
    );
    expect(parsed?.essentialOnly).toBeUndefined();
    emitLogRecord(parsed!);
    expect(outputs).toHaveLength(1);
  });
});
