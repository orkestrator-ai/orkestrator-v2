import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { isDesktopStartupMessage } from "./debug-logging.js";
import {
  configureLogger,
  createLogger,
  formatLogError,
  LOG_RECORD_PREFIX,
  LOG_THROTTLE_MAX_KEYS,
  LOG_THROTTLE_WINDOW_MS,
  logErrorKind,
  resetLogger,
  type LogOutput,
} from "./logger.js";

const START = Date.parse("2026-11-01T10:00:00.000Z");

let outputs: LogOutput[];

beforeEach(() => {
  outputs = [];
  configureLogger({ sink: (output) => void outputs.push(output) });
  setSystemTime(START);
});

afterEach(() => {
  resetLogger();
  setSystemTime();
});

const log = createLogger("tmux");
const EVENT = "poll.snapshot-failed";
const OTHER_EVENT = "poll.tail-failed";

const at = (ms: number) => setSystemTime(START + ms);
const lines = () => outputs.map((output) => output.line);
const records = () => outputs.map((output) => output.record!);
const events = () => records().map((record) => record.event);

function fail(error: unknown, scope?: string): void {
  log.throttled("warn", EVENT, {
    ...(scope === undefined ? {} : { scope }),
    error,
    fields: () => ({ error: formatLogError(error, { stack: false }) }),
  });
}

function coded(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("a repeating fault", () => {
  test("writes the first occurrence in full, and only counts repeats", () => {
    fail(coded("EACCES", "first detail"));
    expect(lines()).toEqual([
      `[tmux] ${EVENT} kind=EACCES error.name=Error error.message="first detail" error.code=EACCES`,
    ]);

    const fields = mock(() => ({ attempt: 2 }));
    for (let repeat = 0; repeat < 100; repeat += 1) {
      log.throttled("warn", EVENT, { error: coded("EACCES"), fields });
    }
    expect(outputs).toHaveLength(1);
    expect(fields).not.toHaveBeenCalled();
  });

  test("a first occurrence with a scope and static kind carries both", () => {
    log.throttled("warn", EVENT, { scope: "tab-1", kind: "no-session" });
    expect(records()[0]?.fields).toEqual({ scope: "tab-1", kind: "no-session" });
  });

  test("a site's own fields that throw do not lose the line or its key", () => {
    log.throttled("warn", EVENT, {
      kind: "no-session",
      fields: () => {
        throw new Error("from the caller");
      },
    });
    expect(records()[0]?.fields).toEqual({ kind: "no-session", fieldsFailed: true });
  });

  test("the same type with different messages is one key", () => {
    fail(new TypeError("about /a"));
    fail(new TypeError("about /b"));
    fail(new TypeError("about /c"));
    expect(outputs).toHaveLength(1);
  });
});

describe("the window", () => {
  test("one summary line per window, at the call's level, with the count", () => {
    fail(coded("EACCES"));
    for (let repeat = 0; repeat < 240; repeat += 1) {
      at(repeat * 200);
      fail(coded("EACCES"));
    }
    expect(outputs).toHaveLength(1);

    at(LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"));
    expect(outputs).toHaveLength(2);
    expect(outputs[1]?.method).toBe("warn");
    expect(lines()[1]).toBe(
      `[tmux] throttle.suppressed site=${EVENT} kind=EACCES suppressed=240 windowSeconds=60`,
    );

    // The repeat that closed the window counts towards the next one.
    at(LOG_THROTTLE_WINDOW_MS * 2);
    fail(coded("EACCES"));
    expect(records()[2]?.fields).toEqual({
      site: EVENT,
      kind: "EACCES",
      suppressed: 1,
      windowSeconds: 60,
    });
  });

  test("a window with no repeats writes nothing", () => {
    fail(coded("EACCES"));
    at(LOG_THROTTLE_WINDOW_MS * 4);
    fail(coded("EACCES"));
    expect(outputs).toHaveLength(1);
  });

  test("a window reports the time it really covered", () => {
    fail(coded("EACCES"));
    at(1_000);
    fail(coded("EACCES"));
    at(90_000);
    fail(coded("EACCES"));
    expect(records()[1]?.fields?.windowSeconds).toBe(90);
  });

  test("a loop that stopped calling still reports while another throttle runs", () => {
    fail(coded("EACCES"), "closed-tab");
    fail(coded("EACCES"), "closed-tab");
    at(LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"), "live-tab");
    expect(events()).toEqual([EVENT, "throttle.suppressed", EVENT]);
    expect(records()[1]?.fields).toMatchObject({ scope: "closed-tab", suppressed: 1 });
  });

  test("a clock moved backwards closes the window instead of holding it open", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    at(-3_600_000);
    fail(coded("EACCES"));
    expect(records()[1]?.fields).toMatchObject({ suppressed: 1, windowSeconds: 0 });
    at(-3_600_000 + LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"));
    expect(records()[2]?.fields).toMatchObject({ suppressed: 1, windowSeconds: 60 });
  });
});

describe("a new kind of error", () => {
  test("logs straight away on a site already being throttled", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    fail(coded("ENOENT", "new failure"));
    expect(records().map((record) => record.fields?.kind)).toEqual(["EACCES", "ENOENT"]);
    expect(records()[1]?.fields?.error).toMatchObject({ message: "new failure" });
  });

  test("keeps its own count and window", () => {
    fail(coded("EACCES"));
    at(30_000);
    fail(coded("ENOENT"));
    fail(coded("ENOENT"));
    at(LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"));
    fail(coded("ENOENT"));
    // ENOENT's window has 30 s left, and EACCES had no repeats to report.
    expect(events()).toEqual([EVENT, EVENT]);
    at(90_000);
    fail(coded("ENOENT"));
    expect(records()[2]?.fields).toMatchObject({ kind: "ENOENT", suppressed: 2 });
  });

  test("another site or scope is not a repeat", () => {
    fail(coded("EACCES"));
    log.throttled("warn", OTHER_EVENT, { error: coded("EACCES") });
    fail(coded("EACCES"), "tab-2");
    expect(outputs).toHaveLength(3);
  });

  test("the code is preferred, and the message is never the key", () => {
    expect(logErrorKind(coded("EACCES", "secret path"))).toBe("EACCES");
    expect(logErrorKind(Object.assign(new Error("x"), { code: 7 }))).toBe("7");
    expect(logErrorKind(new TypeError("secret path"))).toBe("TypeError");
    expect(logErrorKind(coded("not a code!", "secret path"))).toBe("Error");
    expect(logErrorKind("a thrown string with content")).toBe("NonError");
    expect(logErrorKind({ name: "Object", value: "content" })).toBe("NonError");
    expect(logErrorKind(undefined)).toBe("NonError");
  });

  test("a kind that is not a short static name never reaches the log", () => {
    log.throttled("warn", EVENT, { kind: "user typed this text" });
    expect(records()[0]?.fields?.kind).toBe("invalid-kind");
  });
});

describe("recovery", () => {
  test("writes one line with the fault's totals, including the unreported count", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    at(5_000);
    fail(coded("ENOENT"));
    fail(coded("ENOENT"));
    at(20_000);
    log.recovered(EVENT);
    log.recovered(EVENT);
    expect(lines().at(-1)).toBe(
      `[tmux] throttle.recovered site=${EVENT} failures=4 kinds=2 suppressed=2 faultSeconds=20`,
    );
    expect(events().filter((event) => event === "throttle.recovered")).toHaveLength(1);
    expect(outputs.at(-1)?.method).toBe("warn");
  });

  test("a failure after recovery is a first occurrence again", () => {
    fail(coded("EACCES"));
    log.recovered(EVENT);
    fail(coded("EACCES"));
    expect(events()).toEqual([EVENT, "throttle.recovered", EVENT]);
  });

  test("clears only its own site and scope", () => {
    fail(coded("EACCES"), "tab-1");
    fail(coded("EACCES"), "tab-2");
    log.throttled("warn", OTHER_EVENT, { scope: "tab-1", error: coded("EACCES") });
    log.recovered(EVENT, "tab-1");
    expect(records().at(-1)?.fields).toMatchObject({ site: EVENT, scope: "tab-1" });
    fail(coded("EACCES"), "tab-2");
    log.throttled("warn", OTHER_EVENT, { scope: "tab-1", error: coded("EACCES") });
    expect(outputs).toHaveLength(4);
  });

  test("with no fault it writes nothing and does not even read the clock", () => {
    const now = spyOn(Date, "now");
    try {
      log.recovered(EVENT);
      log.recovered(EVENT, "tab-1");
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
    expect(outputs).toHaveLength(0);
  });
});

describe("the key limit", () => {
  const fill = (count: number, from = 0) => {
    for (let index = from; index < from + count; index += 1) fail(coded("EACCES"), `s-${index}`);
  };

  test("a new key at the limit still logs, and the least recently failing key says it left", () => {
    fill(LOG_THROTTLE_MAX_KEYS);
    fail(coded("EACCES"), "s-0"); // Now the most recent, so s-1 is the oldest.
    outputs.length = 0;

    fail(coded("ENOENT"), "new");
    expect(records().map((record) => [record.event, record.fields?.scope])).toEqual([
      ["throttle.evicted", "s-1"],
      [EVENT, "new"],
    ]);
    expect(records()[0]?.fields).toEqual({
      site: EVENT,
      scope: "s-1",
      kind: "EACCES",
      suppressed: 0,
    });
  });

  test("an evicted key carries its count out, and is a first occurrence if it fails again", () => {
    fill(LOG_THROTTLE_MAX_KEYS);
    fail(coded("EACCES"), "s-0");
    fail(coded("EACCES"), "s-1");
    fail(coded("EACCES"), "s-1");
    // s-2 is now the oldest; evict it, then s-3, then s-4 and so on up to s-0.
    fill(LOG_THROTTLE_MAX_KEYS - 2, LOG_THROTTLE_MAX_KEYS);
    outputs.length = 0;

    fill(1, LOG_THROTTLE_MAX_KEYS * 2); // Evicts s-0, with one repeat.
    expect(records()[0]?.fields).toMatchObject({ scope: "s-0", suppressed: 1 });

    outputs.length = 0;
    fail(coded("EACCES"), "s-2");
    expect(events()).toEqual(["throttle.evicted", EVENT]);
  });

  test("the limit counts keys, not sites, and never grows past it", () => {
    for (let index = 0; index < LOG_THROTTLE_MAX_KEYS * 3; index += 1) {
      log.throttled("warn", EVENT, { kind: `k-${index}` });
    }
    const evicted = events().filter((event) => event === "throttle.evicted");
    expect(evicted).toHaveLength(LOG_THROTTLE_MAX_KEYS * 2);

    // One site, so its one recovered line reports exactly what is still tracked.
    log.recovered(EVENT);
    expect(records().at(-1)?.fields?.kinds).toBe(LOG_THROTTLE_MAX_KEYS);
  });

  test("a repeat at the limit evicts nothing", () => {
    fill(LOG_THROTTLE_MAX_KEYS);
    outputs.length = 0;
    fail(coded("EACCES"), "s-0");
    expect(outputs).toHaveLength(0);
  });

  test("a site that evicts its own only key still tracks the new one", () => {
    fail(coded("EACCES"), "self");
    fill(LOG_THROTTLE_MAX_KEYS - 1);
    outputs.length = 0;
    fail(coded("ENOENT"), "self");
    expect(events()).toEqual(["throttle.evicted", EVENT]);
    fail(coded("ENOENT"), "self");
    expect(outputs).toHaveLength(2);
  });

  test("an over-long scope is cut to a bound in the key and on every line", () => {
    const scope = "x".repeat(4_096);
    fail(coded("EACCES"), scope);
    fail(coded("EACCES"), scope);
    log.recovered(EVENT, scope);
    expect(records().map((record) => String(record.fields?.scope).length)).toEqual([128, 128]);
    expect(events()).toEqual([EVENT, "throttle.recovered"]);
  });
});

describe("levels replaced at runtime", () => {
  test("no decision is captured when the logger or throttle is created", () => {
    configureLogger({ level: "error" });
    const late = createLogger("tmux");
    late.throttled("warn", EVENT, { kind: "no-session" });
    expect(outputs).toHaveLength(0);
    configureLogger({ level: "info" });
    late.throttled("warn", EVENT, { kind: "no-session" });
    expect(outputs).toHaveLength(1);
  });

  test("while the level is off nothing is built, counted or tracked", () => {
    configureLogger({ level: "error" });
    const fields = mock(() => ({ attempt: 1 }));
    const message = mock(() => "boom");
    const error = Object.create(Error.prototype, { message: { get: message } }) as Error;
    for (let repeat = 0; repeat < 50; repeat += 1) {
      log.throttled("warn", EVENT, { error, fields });
    }
    expect(fields).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(outputs).toHaveLength(0);

    // Nothing was tracked, so the first failure the reader can see is written in full.
    configureLogger({ level: "info" });
    log.throttled("warn", EVENT, { kind: "no-session" });
    log.recovered(EVENT);
    expect(records().at(-1)?.fields).toMatchObject({ failures: 1, suppressed: 0 });
  });

  test("a level turned off during a fault drops its count, and the next failure is first again", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    configureLogger({ level: "error" });
    fail(coded("EACCES"));
    configureLogger({ level: "info" });
    at(LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"));
    expect(events()).toEqual([EVENT, EVENT]);
  });

  test("a fault that clears while the level is off writes no recovered line and leaves no state", () => {
    fail(coded("EACCES"));
    configureLogger({ areaLevels: { tmux: "error" } });
    log.recovered(EVENT);
    expect(outputs).toHaveLength(1);
    configureLogger({ areaLevels: {} });
    log.recovered(EVENT);
    expect(outputs).toHaveLength(1);
    fail(coded("EACCES"));
    expect(outputs).toHaveLength(2);
  });

  test("a change that leaves the level on keeps the count", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    configureLogger({ format: "text" });
    configureLogger({ areaLevels: { updater: "error" } });
    log.recovered(EVENT);
    expect(records().at(-1)?.fields).toMatchObject({ suppressed: 1, failures: 2 });
  });

  test("a level off and back on with no call in between costs nothing", () => {
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    configureLogger({ level: "error" });
    configureLogger({ level: "info" });
    fail(coded("EACCES"));
    expect(outputs).toHaveLength(1);
  });

  test("an area's level is what counts", () => {
    configureLogger({ level: "error", areaLevels: { tmux: "warn" } });
    fail(coded("EACCES"));
    expect(outputs).toHaveLength(1);
  });

  test("resetting the logger forgets every key", () => {
    fail(coded("EACCES"));
    configureLogger({ sink: (output) => void outputs.push(output) });
    resetLogger();
    configureLogger({ sink: (output) => void outputs.push(output) });
    fail(coded("EACCES"));
    expect(events()).toEqual([EVENT, EVENT]);
  });
});

describe("what reaches the log", () => {
  const SECRET = "user prompt with sk-secret";

  test("only the first occurrence's own fields can carry detail", () => {
    log.throttled("warn", EVENT, { kind: "no-session", fields: () => ({ note: "detail" }) });
    at(1_000);
    log.throttled("warn", EVENT, { kind: "no-session", fields: () => ({ note: SECRET }) });
    at(LOG_THROTTLE_WINDOW_MS + 1_000);
    log.throttled("warn", EVENT, { kind: "no-session", fields: () => ({ note: SECRET }) });
    log.recovered(EVENT);
    expect(lines().join("\n")).not.toContain("sk-secret");
  });

  test("a summary and a recovery never carry the error's message", () => {
    const error = new Error(SECRET);
    log.throttled("warn", EVENT, { error });
    log.throttled("warn", EVENT, { error });
    at(LOG_THROTTLE_WINDOW_MS);
    log.throttled("warn", EVENT, { error });
    log.recovered(EVENT);
    expect(events()).toEqual([EVENT, "throttle.suppressed", "throttle.recovered"]);
    expect(lines().join("\n")).not.toContain("sk-secret");
  });

  test("summary lines are one JSON line in JSON mode", () => {
    configureLogger({ format: "json" });
    fail(coded("EACCES"));
    fail(coded("EACCES"));
    at(LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES"));
    for (const line of lines()) {
      expect(line.startsWith(LOG_RECORD_PREFIX)).toBe(true);
      expect(line).not.toContain("\n");
    }
    expect(JSON.parse(lines()[1]!)).toMatchObject({
      level: "warn",
      area: "tmux",
      event: "throttle.suppressed",
    });
  });

  test("an area that does not list the throttle's lines is refused by the types", () => {
    const updater = createLogger("updater");
    // @ts-expect-error updater does not spread THROTTLE_LOG_EVENTS
    updater.throttled("warn", "check.failed", { kind: "no-session" });
    // @ts-expect-error updater does not spread THROTTLE_LOG_EVENTS
    updater.recovered("check.failed");
    // At runtime its unlisted summary events are not written under their names.
    updater.throttled("warn" as never, "check.failed" as never, { kind: "no-session" });
    expect(lines().join("\n")).not.toContain("throttle.recovered");
  });

  test("a throttle's own events cannot be used as a site", () => {
    // @ts-expect-error the throttle's lines are not themselves throttled
    log.throttled("warn", "throttle.suppressed", { kind: "no-session" });
  });

  test("a renderer's line is not an allowlisted startup marker, so it stays in the console", () => {
    createLogger("terminal").throttled("warn", "input.undelivered", {
      scope: "tab-1",
      kind: "no-session",
    });
    expect(lines()).toEqual(["[terminal] input.undelivered scope=tab-1 kind=no-session"]);
    expect(isDesktopStartupMessage(lines()[0]!)).toBe(false);
  });

  test("the default sink writes a warning to console.warn", () => {
    resetLogger();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createLogger("terminal").throttled("warn", "input.undelivered", { kind: "no-session" });
      expect(warn).toHaveBeenCalledWith("[terminal] input.undelivered kind=no-session");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("review regressions", () => {
  test("rejected event text is never retained, evaluated or emitted by lifecycle lines", () => {
    const secret = "private user text";
    const fields = mock(() => ({ note: secret }));
    for (const elapsed of [0, 1, LOG_THROTTLE_WINDOW_MS, 2 * LOG_THROTTLE_WINDOW_MS]) {
      at(elapsed);
      log.throttled("warn", secret as never, { kind: "Error", fields });
    }
    log.recovered(secret as never);
    for (let n = 0; n < LOG_THROTTLE_MAX_KEYS; n += 1) fail(coded("EACCES"), `safe-${n}`);
    expect(events().filter((event) => event === "throttle.evicted")).toHaveLength(0);
    expect(events().filter((event) => event === "throttle.recovered")).toHaveLength(0);
    expect(fields).not.toHaveBeenCalled();
    expect(lines().join("\n")).not.toContain(secret);
  });

  test("a hot kind cannot protect stale sibling kinds from global eviction", () => {
    for (let n = 0; n < LOG_THROTTLE_MAX_KEYS - 1; n += 1) {
      log.throttled("warn", EVENT, { kind: `kind-${n}` });
    }
    log.throttled("warn", OTHER_EVENT, { kind: "recent" });
    log.throttled("warn", EVENT, { kind: "kind-510" });
    outputs.length = 0;
    log.throttled("warn", OTHER_EVENT, { kind: "new" });
    expect(records()[0]?.fields).toMatchObject({ site: EVENT, kind: "kind-0" });
    log.throttled("warn", OTHER_EVENT, { kind: "recent" });
    log.throttled("warn", OTHER_EVENT, { kind: "new" });
    expect(events()).toEqual(["throttle.evicted", OTHER_EVENT]);
  });

  test("a failure after five idle windows includes its new diagnostic", () => {
    fail(coded("EACCES", "old detail"));
    at(5 * LOG_THROTTLE_WINDOW_MS);
    fail(coded("EACCES", "new detail"));
    expect(events()).toEqual([EVENT, EVENT]);
    expect(lines().at(-1)).toContain("new detail");
    log.recovered(EVENT);
    expect(records().at(-1)?.fields).toMatchObject({ failures: 1 });
  });
});
