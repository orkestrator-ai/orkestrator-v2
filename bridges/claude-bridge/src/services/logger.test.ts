import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRequestLogger, readDebugFlag } from "./logger.js";

describe("readDebugFlag", () => {
  test("is off when the variable is unset or blank", () => {
    expect(readDebugFlag(undefined)).toBe(false);
    expect(readDebugFlag("")).toBe(false);
    expect(readDebugFlag("   ")).toBe(false);
  });

  test("is off for the conventional negative spellings, in any case or padding", () => {
    // A profile that exports CLAUDE_BRIDGE_DEBUG=0 must not silently enable
    // per-token logging on every bridge the user starts.
    for (const value of ["0", "false", "off", "no", "FALSE", " Off ", "No"]) {
      expect(readDebugFlag(value)).toBe(false);
    }
  });

  test("requires the same explicit opt-in as every other bridge", () => {
    for (const value of ["1", " 1 "]) {
      expect(readDebugFlag(value)).toBe(true);
    }
  });
});

describe("createRequestLogger", () => {
  test("returns no middleware when debug logging is off", () => {
    expect(createRequestLogger(false)).toBeNull();
  });

  test("returns middleware when debug logging is on", () => {
    const middleware = createRequestLogger(true);
    expect(typeof middleware).toBe("function");
  });

  test("never records URL paths or query parameters", async () => {
    const token = "live-bridge-credential";
    const records: unknown[] = [];
    const app = new Hono();
    app.use(
      "*",
      createRequestLogger(true, (...parts) => {
        records.push(parts);
      })!,
    );
    app.get("/event/subscribe", (context) => context.text("ok"));

    await app.request(`/event/subscribe?token=${token}&cursor=4`);

    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain("/event/subscribe");
    expect(JSON.stringify(records)).not.toContain("cursor");
    expect(records).toEqual([["http-request", expect.objectContaining({ httpStatus: 200 })]]);
  });
});
