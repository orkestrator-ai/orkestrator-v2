import { describe, expect, test } from "bun:test";
import {
  backendArgsFromCmdline,
  secondBackendArgs,
  takeoverLease,
} from "./schedules-two-backends-support";

const FIRST = [
  "--port",
  "36343",
  "--control-host",
  "127.0.0.1",
  "--control-port",
  "0",
  "--data-dir",
  "/p/data",
  "--strict-gateway-port",
];

describe("the second backend's command line", () => {
  test("changes only the gateway port", () => {
    const second = secondBackendArgs(FIRST, 41000);
    expect(second).toEqual(FIRST.map((arg) => (arg === "36343" ? "41000" : arg)));
    expect(FIRST[1]).toBe("36343");
  });

  test("refuses a command line it cannot share safely", () => {
    expect(() => secondBackendArgs(["--data-dir", "/p"], 1)).toThrow("no --port");
    expect(() => secondBackendArgs(["--port", "1"], 2)).toThrow("no --data-dir");
    expect(() => secondBackendArgs(FIRST, 36343)).toThrow("its own port");
    const fixed = FIRST.map((arg, index) => (index === 5 ? "45000" : arg));
    expect(() => secondBackendArgs(fixed, 41000)).toThrow("control port is fixed");
  });

  test("reads the arguments after this checkout's entry", () => {
    const cmdline = ["bun", "/repo/apps/backend/src/main.ts", "--port", "1", ""].join("\0");
    expect(backendArgsFromCmdline(cmdline, "/repo/apps/backend/src/main.ts")).toEqual([
      "--port",
      "1",
    ]);
    expect(() => backendArgsFromCmdline(cmdline, "/other/main.ts")).toThrow("not this checkout");
  });
});

test("the takeover lease is a lease document under a fresh token", () => {
  const first = takeoverLease(42, new Date("2026-11-14T00:00:00.000Z"));
  const second = takeoverLease(42);
  expect(JSON.parse(first.body)).toEqual({
    token: first.token,
    pid: 42,
    acquiredAt: "2026-11-14T00:00:00.000Z",
  });
  expect(second.token).not.toBe(first.token);
});
