import { describe, expect, test } from "bun:test";

import {
  classifyMcpToolAvailability,
  waitForMcpToolAvailability,
} from "./mcp-tool-availability.js";

const TOOL = "submit_consolidated_review";

function server(fields: Record<string, unknown>) {
  return { data: [{ name: "orkestrator", tools: {}, toolsError: null, ...fields }] };
}

describe("classifyMcpToolAvailability", () => {
  test("finds a tool by its raw name", () => {
    expect(
      classifyMcpToolAvailability(
        server({ runtimeStatus: "connected", tools: { [TOOL]: { name: TOOL } } }),
        "orkestrator",
        TOOL,
      ),
    ).toEqual({ state: "available" });
  });

  test("a connected server without the tool is missing it", () => {
    expect(
      classifyMcpToolAvailability(
        server({
          runtimeStatus: "connected",
          tools: { submit_validation_plan: { name: "submit_validation_plan" } },
        }),
        "orkestrator",
        TOOL,
      ),
    ).toEqual({ state: "missing", reason: `does not list ${TOOL}` });
  });

  test("an unconfigured or failed server is missing the tool", () => {
    expect(classifyMcpToolAvailability({ data: [] }, "orkestrator", TOOL)).toMatchObject({
      state: "missing",
    });
    expect(
      classifyMcpToolAvailability(server({ runtimeStatus: "failed" }), "orkestrator", TOOL),
    ).toEqual({ state: "missing", reason: "is failed" });
    expect(
      classifyMcpToolAvailability(
        server({ runtimeStatus: "connected", toolsError: "boom" }),
        "orkestrator",
        TOOL,
      ),
    ).toEqual({ state: "missing", reason: "could not list its tools" });
  });

  test("a starting server is undecided and a malformed answer is unverified", () => {
    expect(
      classifyMcpToolAvailability(server({ runtimeStatus: "starting" }), "orkestrator", TOOL),
    ).toBeUndefined();
    expect(classifyMcpToolAvailability({}, "orkestrator", TOOL)).toEqual({
      state: "unverified",
    });
  });
});

describe("waitForMcpToolAvailability", () => {
  test("waits for a starting server to list its tools", async () => {
    const answers = [
      server({ runtimeStatus: "starting" }),
      server({ runtimeStatus: "connected", tools: { [TOOL]: { name: TOOL } } }),
    ];
    let calls = 0;
    const availability = await waitForMcpToolAvailability(
      async () => answers[Math.min(calls++, answers.length - 1)],
      "orkestrator",
      TOOL,
      { pollMs: 1 },
    );
    expect(availability).toEqual({ state: "available" });
    expect(calls).toBe(2);
  });

  test("a server still starting at the deadline is unverified, not missing", async () => {
    let clock = 0;
    const availability = await waitForMcpToolAvailability(
      async () => {
        clock += 10;
        return server({ runtimeStatus: "starting" });
      },
      "orkestrator",
      TOOL,
      { timeoutMs: 25, pollMs: 1, now: () => clock },
    );
    expect(availability).toEqual({ state: "unverified" });
  });

  test("a stalled listing settles within the availability budget", async () => {
    let budget: number | undefined;
    const started = Date.now();
    const result = await waitForMcpToolAvailability(
      (timeoutMs) => {
        budget = timeoutMs;
        return new Promise(() => {});
      },
      "orkestrator",
      TOOL,
      { timeoutMs: 25 },
    );
    expect(result).toEqual({ state: "unverified" });
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(25);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test.each([true, false])(
    "ignores a definite answer after the deadline (available=%s)",
    async (available) => {
      let clock = 0;
      expect(
        await waitForMcpToolAvailability(
          async () => {
            clock = 26;
            return server({
              runtimeStatus: "connected",
              tools: available ? { [TOOL]: { name: TOOL } } : {},
            });
          },
          "orkestrator",
          TOOL,
          { timeoutMs: 25, now: () => clock },
        ),
      ).toEqual({ state: "unverified" });
    },
  );

  test("a late listing rejection is handled after the deadline", async () => {
    let reject!: (error: Error) => void;
    const listing = new Promise((_, rejectListing) => {
      reject = rejectListing;
    });
    expect(
      await waitForMcpToolAvailability(() => listing, "orkestrator", TOOL, { timeoutMs: 10 }),
    ).toEqual({ state: "unverified" });
    reject(new Error("late transport failure"));
    await Promise.resolve();
  });

  test("a failed status request is unverified", async () => {
    expect(
      await waitForMcpToolAvailability(
        async () => {
          throw new Error("unsupported");
        },
        "orkestrator",
        TOOL,
      ),
    ).toEqual({ state: "unverified" });
  });
});
