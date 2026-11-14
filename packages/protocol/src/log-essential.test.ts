import { describe, expect, test } from "bun:test";
import { hasEssentialEvents, isEssentialEntry, projectEssentialRecord } from "./log-essential.js";
import { LOG_VOCABULARY, type LogAreaSpec } from "./log-vocabulary/index.js";
import { formatLogError, type LogLevel, type LogRecord, type LogWireValue } from "./logger.js";

const TS = "2026-11-04T10:00:00.000Z";
const areas = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;

function record(
  area: string,
  event: string,
  level: LogLevel,
  fields?: Record<string, LogWireValue>,
): LogRecord {
  return { orklog: 1, ts: TS, level, area, event, ...(fields ? { fields } : {}) };
}

const essentialEvents = Object.entries(areas).flatMap(([area, spec]) =>
  Object.entries(spec.events).flatMap(([event, definition]) =>
    typeof definition === "object" ? [{ area, event, definition }] : [],
  ),
);

const SECRET = "/Users/someone/project sk-ant-secret prompt text";

describe("what belongs", () => {
  test("every error and each flagged event, and nothing else", () => {
    expect(isEssentialEntry("docker", "writer-lease.lost", "warn")).toBe(true);
    expect(isEssentialEntry("docker", "login-keeper.pass-failed", "warn")).toBe(false);
    expect(isEssentialEntry("docker", "login-keeper.pass-failed", "error")).toBe(true);
    expect(isEssentialEntry("docker", "not-an-event", "info")).toBe(false);
    expect(isEssentialEntry("not-an-area", "starting", "info")).toBe(false);
  });

  test("a stall counts only at error, which is 10 seconds or more", () => {
    expect(isEssentialEntry("event-loop", "stalled", "warn")).toBe(false);
    expect(isEssentialEntry("event-loop", "stalled", "error")).toBe(true);
    expect(isEssentialEntry("desktop", "main-thread.stalled", "warn")).toBe(false);
    expect(isEssentialEntry("desktop", "main-thread.stalled", "error")).toBe(true);
  });

  test("reporting a failed write can never become another write", () => {
    expect(isEssentialEntry("logging", "essential.write-failed", "warn")).toBe(false);
    expect(isEssentialEntry("logging", "essential.write-failed", "error")).toBe(false);
    expect(isEssentialEntry("logging", "throttle.suppressed", "warn")).toBe(false);
  });

  test("an area with no essential event is recognised, so its loggers skip the lookup", () => {
    expect(hasEssentialEvents("docker")).toBe(true);
    expect(hasEssentialEvents("web.kanban")).toBe(false);
    expect(hasEssentialEvents("not-an-area")).toBe(false);
  });
});

describe("what is kept", () => {
  test("no essential event keeps hostile text, whichever field it arrives in", () => {
    for (const { area, event, definition } of essentialEvents) {
      const hostile: Record<string, LogWireValue> = { path: SECRET, message: SECRET };
      for (const name of Object.keys(definition.fields)) {
        if (!name.includes(".")) hostile[name] = SECRET;
      }
      const error = new Error(SECRET);
      hostile.error = formatLogError(Object.assign(error, { code: SECRET, name: "Boom" }));
      const projected = projectEssentialRecord(record(area, event, "error", hostile), TS);
      expect(JSON.stringify(projected)).not.toContain("secret");
      expect(JSON.stringify(projected)).not.toContain("/Users");
    }
  });

  test.each(["private-user-token", "secret", "sk-ant-abcdef"])(
    "rejects token-shaped text %s in every declared label and error identity",
    (secret) => {
      for (const { area, event, definition } of essentialEvents) {
        const fields: Record<string, LogWireValue> = {};
        for (const name of Object.keys(definition.fields)) fields[name] = secret;
        fields.error = { name: secret, code: secret, syscall: secret, signal: secret };
        expect(
          JSON.stringify(projectEssentialRecord(record(area, event, "error", fields), TS)),
        ).not.toContain(secret);
      }
      const fields = {
        reason: secret,
        kind: secret,
        code: secret,
        step: secret,
        site: secret,
        signal: secret,
        error: { name: secret, code: secret, syscall: secret, signal: secret },
      };
      expect(
        projectEssentialRecord(record("bridge.pi", "turn.failed", "error", fields), TS)?.fields,
      ).toEqual({ droppedFields: 10 });
    },
  );

  test("declared fields are kept, with each kind checked", () => {
    expect(
      projectEssentialRecord(
        record("local-server", "bridge.exited", "warn", {
          key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
          pid: 42,
          code: null,
          signal: "SIGKILL",
          requested: false,
          stray: 7,
        }),
        TS,
      )?.fields,
    ).toEqual({
      key: "codex:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
      pid: 42,
      code: null,
      signal: "SIGKILL",
      requested: false,
    });
    expect(
      projectEssentialRecord(
        record("local-server", "bridge.exited", "warn", { pid: "not a number", key: "has space" }),
        TS,
      )?.fields,
    ).toEqual({ droppedFields: 2 });
  });

  test("an error keeps its identity and never its message, stack or cause", () => {
    const error = Object.assign(
      new Error(`ENOENT: open '${SECRET}'`, { cause: new Error(SECRET) }),
      {
        code: "ENOENT",
        errno: -2,
        syscall: "open",
      },
    );
    const projected = projectEssentialRecord(
      record("process", "uncaught-exception", "error", {
        origin: "uncaughtException",
        error: formatLogError(error),
      }),
      TS,
    );
    expect(projected?.fields).toEqual({
      origin: "uncaughtException",
      "error.name": "Error",
      "error.code": "ENOENT",
      "error.errno": -2,
      "error.syscall": "open",
    });
  });

  test("an undeclared error keeps numbers, booleans and fixed labels, and no other string", () => {
    const projected = projectEssentialRecord(
      record("desktop", "startup.failed", "error", {
        step: "gateway",
        attempts: 3,
        retried: true,
        exitCode: null,
        directory: SECRET,
        id: "6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        error: formatLogError(new TypeError(SECRET)),
      }),
      TS,
    );
    expect(projected?.fields).toEqual({
      step: "gateway",
      attempts: 3,
      retried: true,
      exitCode: null,
      "error.name": "TypeError",
      droppedFields: 2,
    });
  });

  test("a throttle summary at error still says which site", () => {
    expect(
      projectEssentialRecord(
        record("process", "throttle.suppressed", "error", {
          site: "rejection.unhandled",
          kind: "TypeError",
          suppressed: 40,
          windowSeconds: 60,
          scope: SECRET,
        }),
        TS,
      )?.fields,
    ).toEqual({
      site: "rejection.unhandled",
      kind: "TypeError",
      suppressed: 40,
      windowSeconds: 60,
      droppedFields: 1,
    });
  });

  test("the relay's source is kept, and a claimed one must still be a label", () => {
    expect(
      projectEssentialRecord(
        record("bridge.pi", "session.resume-fell-back", "warn", {
          source: "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
          sessionId: "6e0a6a7e",
        }),
        TS,
      )?.fields,
    ).toEqual({ source: "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f" });
    expect(
      projectEssentialRecord(
        record("bridge.pi", "session.resume-fell-back", "warn", { source: SECRET }),
        TS,
      )?.fields,
    ).toEqual({ droppedFields: 1 });
  });

  test("a timestamp that does not look like one is replaced", () => {
    const line = record("backend", "starting", "info");
    expect(projectEssentialRecord({ ...line, ts: SECRET }, TS)?.ts).toBe(TS);
    expect(projectEssentialRecord({ ...line, ts: "2026-01-02T03:04:05Z" }, TS)?.ts).toBe(
      "2026-01-02T03:04:05Z",
    );
  });

  test("an entry that does not belong is refused", () => {
    expect(projectEssentialRecord(record("backend", "ssh-socket.missing", "warn"), TS)).toBeNull();
  });
});

test.each([1, true, null, { name: "TypeError", errno: -2 }])(
  "undeclared error rejects secret-bearing keys with value %j",
  (value) => {
    const projected = projectEssentialRecord(
      record("bridge.pi", "turn.failed", "error", {
        "sk-ant-private-key": value,
        error: { name: "TypeError", code: "ENOENT" },
      }),
      TS,
    );
    expect(JSON.stringify(projected)).not.toContain("sk-ant-private-key");
    expect(projected?.fields).toEqual({
      "error.name": "TypeError",
      "error.code": "ENOENT",
      droppedFields: 1,
    });
  },
);

describe("backend previous-run", () => {
  test("keeps its outcome and numbers, and refuses any other outcome", () => {
    const entry = (outcome: string) =>
      record("backend", "previous-run", "warn", {
        outcome,
        ranForMs: 5,
        lastSeenAgoMs: 6,
        extra: "/home/someone",
      });
    expect(projectEssentialRecord(entry("crashed"), TS)?.fields).toEqual({
      outcome: "crashed",
      ranForMs: 5,
      lastSeenAgoMs: 6,
    });
    expect(projectEssentialRecord(entry("/home/someone"), TS)?.fields?.outcome).toBeUndefined();
  });
});

describe("storage operation.slow and its stall context", () => {
  test("keeps the database, kind, table and times, and never a store id or an id-shaped table", () => {
    const projected = projectEssentialRecord(
      record("storage", "operation.slow", "warn", {
        database: "main",
        op: "transaction",
        table: "store_rows",
        store: "native-agent-sessions",
        mode: "immediate",
        durationMs: 9_811,
        beginMs: 9_811,
        sqlMs: 0,
        busy: true,
      }),
      TS,
    );
    expect(projected?.fields).toEqual({
      database: "main",
      op: "transaction",
      table: "store_rows",
      mode: "immediate",
      durationMs: 9_811,
      beginMs: 9_811,
      sqlMs: 0,
      busy: true,
    });
    const hostile = projectEssentialRecord(
      record("storage", "operation.slow", "warn", {
        database: "/Users/someone/orkestrator.sqlite",
        op: "drop table",
        table: "abc123def456",
        mode: "sk-ant-secret",
        durationMs: 300,
      }),
      TS,
    );
    expect(hostile?.fields).toMatchObject({ durationMs: 300 });
    expect(hostile?.fields).not.toHaveProperty("database");
    expect(hostile?.fields).not.toHaveProperty("op");
    expect(hostile?.fields).not.toHaveProperty("table");
    expect(hostile?.fields).not.toHaveProperty("mode");
  });

  test("a 10-second stall keeps the storage operation that ran during it", () => {
    const projected = projectEssentialRecord(
      record("event-loop", "stalled", "error", {
        lagMs: 10_200,
        intervalMs: 500,
        storageMs: 9_811,
        storageDatabase: "main",
        storageOp: "transaction",
        storageTable: "stores",
        storageStore: "environments",
        storageLongestMs: 9_811,
        storageBusy: true,
        commandsInFlight: 3,
        commands: "get_projects",
      }),
      TS,
    );
    expect(projected?.fields).toEqual({
      lagMs: 10_200,
      intervalMs: 500,
      storageMs: 9_811,
      storageDatabase: "main",
      storageOp: "transaction",
      storageTable: "stores",
      storageLongestMs: 9_811,
      storageBusy: true,
      commandsInFlight: 3,
    });
  });
});

describe("local-server bridge.orphans-reaped", () => {
  test("keeps its result, and refuses any other value", () => {
    const entry = (result: string) =>
      record("local-server", "bridge.orphans-reaped", "warn", {
        key: "claude:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        pid: 4242,
        result,
      });
    expect(projectEssentialRecord(entry("stopped"), TS)?.fields).toEqual({
      key: "claude:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
      pid: 4242,
      result: "stopped",
    });
    expect(projectEssentialRecord(entry("/home/someone"), TS)?.fields?.result).toBeUndefined();
  });
});

describe("bridge.claude query.failed", () => {
  test("keeps the SDK's subtype and API error code, and refuses any other value", () => {
    const entry = (subtype: string, reason: string) =>
      record("bridge.claude", "query.failed", "error", {
        subtype,
        isError: true,
        reason,
        apiStatus: 400,
        startupFailure: false,
        sessionId: "session-client-41e14f6d1cf34347b31f3bc1996d9aa2",
      });
    expect(projectEssentialRecord(entry("error_max_turns", "invalid_request"), TS)?.fields).toEqual(
      {
        subtype: "error_max_turns",
        isError: true,
        reason: "invalid_request",
        apiStatus: 400,
        startupFailure: false,
      },
    );
    expect(
      projectEssentialRecord(entry("Failed to authenticate", "API Error: 403"), TS)?.fields,
    ).toEqual({ isError: true, apiStatus: 400, startupFailure: false, droppedFields: 2 });
  });
});

describe("renderer error entries", () => {
  const fields = {
    errorClass: "TypeError",
    boundary: "message-row",
    route: "window",
    fingerprint: "0a1b2c3d",
    count: 3,
  };

  test("an entry keeps its five fields and nothing a sender adds", () => {
    const projected = projectEssentialRecord(
      record("renderer-errors", "error.recorded", "warn", {
        ...fields,
        message: SECRET,
        stack: `TypeError: ${SECRET}\n    at render (/Users/someone/app.js:1:1)`,
      }),
      TS,
    );
    expect(projected?.fields).toEqual(fields);
    expect(JSON.stringify(projected)).not.toContain("someone");
  });

  test("a value outside its list is dropped, not written", () => {
    const projected = projectEssentialRecord(
      record("renderer-errors", "error.recorded", "warn", {
        errorClass: "MyAppError",
        boundary: SECRET,
        route: "/settings/debug",
        fingerprint: "not-a-hash",
        count: 1,
      }),
      TS,
    );
    expect(projected?.fields).toEqual({ count: 1, droppedFields: 4 });
  });
});
