import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureLogger,
  createLogger,
  emitLogRecord,
  parseLogRecordLine,
  resetLogger,
} from "@orkestrator/protocol/logger";
import { installEssentialLog } from "@orkestrator/protocol/node/essential-log";
import { relayBridgeOutput } from "./bridge-output-redaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetLogger();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Plays each process in turn, because the logger is one per process: a local
 * bridge whose level hides the line, the backend's hop, and the desktop that owns
 * the file. Each line is what the process before it printed.
 */
test("a bridge's filtered essential entry crosses both relays, stays out of the normal log, and is kept", async () => {
  const printed: string[] = [];
  const printing = {
    format: "json" as const,
    relayEssential: true,
    sink: ({ line }: { line: string }) => void printed.push(line),
  };

  // The bridge: `bridge=error` hides its `warn`.
  configureLogger({ ...printing, level: "error", areaLevels: { bridge: "error" } });
  createLogger("bridge.pi").warn("session.resume-fell-back", { sessionId: "provider-session-1" });
  const bridgeLine = printed.splice(0)[0]!;

  // The backend's hop, which adds where it came from and passes it on.
  resetLogger();
  configureLogger(printing);
  relayBridgeOutput("stdout", "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f", bridgeLine);
  const backendLine = printed.splice(0)[0]!;

  // The desktop, which owns the file and whose normal log must not get it.
  resetLogger();
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-essential-relay-"));
  temporaryDirectories.push(directory);
  const normalLog: string[] = [];
  configureLogger({ sink: ({ line }) => void normalLog.push(line) });
  const essential = installEssentialLog({ dataDir: directory, owner: "desktop" });
  emitLogRecord(parseLogRecordLine(backendLine)!);
  await essential.stop();

  expect(normalLog).toEqual([]);
  const text = await readFile(path.join(essential.directory, "essential.jsonl"), "utf8");
  const kept = text.split("\n").flatMap((line) => {
    const record = parseLogRecordLine(line);
    return record?.event === "session.resume-fell-back" ? [record] : [];
  });
  expect(kept).toHaveLength(1);
  expect(kept[0]?.area).toBe("bridge.pi");
  // The provider's session id stayed behind; only the bridge and environment crossed.
  expect(kept[0]?.fields).toEqual({ source: "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f" });
  expect(text).not.toContain("provider-session-1");
});

test("recognized child errors cannot persist arbitrary label-shaped strings with saving off", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-essential-relay-"));
  temporaryDirectories.push(directory);
  configureLogger({ sink: () => {} });
  const essential = installEssentialLog({ dataDir: directory, owner: "desktop" });
  try {
    for (const secret of ["private-user-token", "secret", "sk-ant-abcdef"]) {
      relayBridgeOutput(
        "stdout",
        "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
        JSON.stringify({
          orklog: 1,
          ts: new Date().toISOString(),
          area: "bridge.pi",
          event: "turn.failed",
          level: "error",
          fields: {
            [secret + "-number"]: 1,
            [secret + "-boolean"]: true,
            [secret + "-null"]: null,
            [secret + "-error"]: { name: "TypeError", errno: -2 },
            reason: secret,
            kind: secret,
            code: secret,
            error: { name: secret, code: secret, syscall: secret, signal: secret },
          },
        }),
      );
    }
    relayBridgeOutput(
      "stderr",
      "pi:6e0a6a7e-1111-4e95-817f-084f44d18e8f",
      JSON.stringify({
        orklog: 1,
        ts: new Date().toISOString(),
        area: "bridge.pi",
        event: "turn.failed",
        level: "error",
        fields: { error: { name: "TypeError", code: "ENOENT", syscall: "open" } },
      }),
    );
  } finally {
    await essential.stop();
  }
  const text = await readFile(path.join(essential.directory, "essential.jsonl"), "utf8");
  for (const secret of ["private-user-token", "secret", "sk-ant-abcdef"])
    expect(text).not.toContain(secret);
  expect(text).toContain('"error.name":"TypeError"');
  expect(text).toContain('"error.code":"ENOENT"');
  expect(text).toContain('"error.syscall":"open"');
  expect(text.split("\n").filter((line) => line.includes('"event":"turn.failed"'))).toHaveLength(4);
});
