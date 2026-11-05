import { describe, expect, test } from "bun:test";
import {
  TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
} from "@orkestrator/protocol/terminal-websocket";

import {
  SESSION,
  startTerminalClient,
  type TerminalClientFixture,
} from "../scripts/terminal-input-costs";

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Sends each key, without waiting for one to finish, and records how each one settles. */
async function typeKeys(fixture: TerminalClientFixture, keys: string[], everyKeys: number) {
  const settled: Array<{ key: string; outcome: string }> = [];
  const pending: Promise<void>[] = [];
  for (const [index, key] of keys.entries()) {
    const completion = fixture.client.enqueueInput(SESSION, key);
    if (!completion) throw new Error("The channel refused a keystroke");
    pending.push(
      completion.then(
        () => void settled.push({ key, outcome: "ok" }),
        (error: Error) => void settled.push({ key, outcome: error.message }),
      ),
    );
    if ((index + 1) % everyKeys === 0) await nextTask();
  }
  await Promise.all(pending);
  return settled;
}

const KEYS = Array.from({ length: 120 }, (_, index) => `k${index}`);

describe("the renderer's terminal client against the gateway", () => {
  test("keystrokes settle in order, with none lost and fewer result frames", async () => {
    const fixture = await startTerminalClient();
    try {
      expect(fixture.protocol()).toBe(TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL);
      const settled = await typeKeys(fixture, KEYS, KEYS.length);
      expect(settled).toEqual(KEYS.map((key) => ({ key, outcome: "ok" })));
      expect(fixture.writes).toEqual(KEYS);
      expect(fixture.wire.resultFrames).toBeLessThan(KEYS.length);
    } finally {
      await fixture.stop();
    }
  });

  test("order holds when writes take time and results finish in separate turns", async () => {
    const fixture = await startTerminalClient({
      write: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    try {
      const keys = KEYS.slice(0, 40);
      const settled = await typeKeys(fixture, keys, 3);
      expect(settled).toEqual(keys.map((key) => ({ key, outcome: "ok" })));
      expect(fixture.writes).toEqual(keys);
    } finally {
      await fixture.stop();
    }
  });

  test("a keystroke that fails fails alone, and the ones around it still settle", async () => {
    const failing = new Set(["k7", "k41", "k42", "k119"]);
    const fixture = await startTerminalClient({
      write: (data) => (failing.has(data) ? { delivered: false } : undefined),
    });
    try {
      const settled = await typeKeys(fixture, KEYS, 5);
      expect(settled.map((entry) => entry.key).sort()).toEqual([...KEYS].sort());
      for (const { key, outcome } of settled) {
        expect(outcome).toBe(failing.has(key) ? "Terminal session is not running" : "ok");
      }
      // Promise reactions run in the order the client settled them.
      expect(settled.map((entry) => entry.key)).toEqual(KEYS);
      expect(fixture.writes).toEqual(KEYS);
      expect(fixture.wire.failures).toBe(failing.size);
    } finally {
      await fixture.stop();
    }
  });

  test("an older client that offers only v1 works the same, with one frame per key", async () => {
    const fixture = await startTerminalClient({ protocols: [TERMINAL_WEBSOCKET_SUBPROTOCOL] });
    try {
      expect(fixture.protocol()).toBe(TERMINAL_WEBSOCKET_SUBPROTOCOL);
      const settled = await typeKeys(fixture, KEYS, KEYS.length);
      expect(settled).toEqual(KEYS.map((key) => ({ key, outcome: "ok" })));
      expect(fixture.writes).toEqual(KEYS);
      expect(fixture.wire.resultFrames).toBe(KEYS.length);
    } finally {
      await fixture.stop();
    }
  });
});
