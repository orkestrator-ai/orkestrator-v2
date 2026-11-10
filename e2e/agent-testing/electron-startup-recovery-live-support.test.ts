import { describe, expect, test } from "bun:test";
import http from "node:http";
import { STARTUP_FAILED_TEXT } from "./electron-startup-recovery";
import {
  churnLoadUntilAborted,
  churnNetworkUntil,
  DEFAULT_CHURN_BURSTS,
  NETWORK_SETTLE_MS,
  serveModuleFanOut,
} from "./electron-startup-recovery-live-support";

/** Records the interface changes and pauses a churn makes, without running `ip`. */
function recordingChurn() {
  const calls: string[] = [];
  const pauses: number[] = [];
  return {
    calls,
    pauses,
    ip: (...args: string[]) => {
      calls.push(args.slice(0, 2).join(" "));
    },
    pause: async (ms: number) => {
      pauses.push(ms);
    },
  };
}

/**
 * A plain GET. The root preload's DOM `fetch` applies CORS to a loopback page,
 * and its `URL` is not one `node:http` recognises, so this takes a string.
 */
function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

const ADD = ["link add", "addr add", "link set"];

describe("churnNetworkUntil", () => {
  test("removes a bridge it left up when the abort arrives, then settles", async () => {
    const churn = recordingChurn();
    let checks = 0;
    // The abort is seen after the third change: add, remove, add.
    const changes = await churnNetworkUntil(() => (checks += 1) > 3, churn);

    expect(churn.calls).toEqual([...ADD, "link del", ...ADD, "link del"]);
    expect(changes).toBe(4);
    expect(churn.pauses).toEqual([50, 50, 50, NETWORK_SETTLE_MS]);
  });

  test("ends on its own removal without adding another one", async () => {
    const churn = recordingChurn();
    let checks = 0;
    const changes = await churnNetworkUntil(() => (checks += 1) > 2, churn);

    expect(churn.calls).toEqual([...ADD, "link del"]);
    expect(changes).toBe(2);
    expect(churn.pauses.at(-1)).toBe(NETWORK_SETTLE_MS);
  });

  test("stops at its change budget with the bridge removed", async () => {
    const churn = recordingChurn();
    const changes = await churnNetworkUntil(() => false, { ...churn, maxChanges: 3 });

    expect(churn.calls.filter((call) => call === "link add")).toHaveLength(2);
    expect(churn.calls.at(-1)).toBe("link del");
    expect(changes).toBe(4);
  });

  test("removes the bridge when an interface change throws", async () => {
    const churn = recordingChurn();
    let calls = 0;
    const failing = (...args: string[]) => {
      calls += 1;
      // The address step of the second add fails.
      if (calls === 6) throw new Error("ip failed");
      churn.ip(...args);
    };

    await expect(churnNetworkUntil(() => false, { ...churn, ip: failing })).rejects.toThrow(
      "ip failed",
    );
    expect(churn.calls).toEqual([...ADD, "link del", "link add", "link del"]);
  });

  test("makes no change once the abort is already seen, and still settles", async () => {
    const churn = recordingChurn();
    expect(await churnNetworkUntil(() => true, churn)).toBe(0);
    expect(churn.calls).toEqual([]);
    expect(churn.pauses).toEqual([NETWORK_SETTLE_MS]);
  });
});

describe("churnLoadUntilAborted", () => {
  test("restarts the load after a burst that aborted nothing, then stops at the abort", async () => {
    const churn = recordingChurn();
    const events: string[] = [];
    let abortedAfter = Infinity;
    const result = await churnLoadUntilAborted(
      () => churn.calls.length >= abortedAfter,
      async () => {
        events.push(`restart after ${churn.calls.length} calls`);
        // The second load's modules are aborted by its burst's first change.
        abortedAfter = churn.calls.length + ADD.length;
      },
      { ...churn, maxChanges: 2 },
    );

    expect(events).toEqual([`restart after ${ADD.length + 1} calls`]);
    expect(result).toEqual({ bursts: 2, interfaceChanges: 4 });
    expect(churn.calls).toEqual([...ADD, "link del", ...ADD, "link del"]);
  });

  test("does not restart once the first burst saw an abort", async () => {
    const churn = recordingChurn();
    let restarts = 0;
    const result = await churnLoadUntilAborted(
      () => churn.calls.length > 0,
      async () => {
        restarts += 1;
      },
      churn,
    );
    expect(restarts).toBe(0);
    expect(result).toEqual({ bursts: 1, interfaceChanges: 2 });
  });

  test("gives up after its burst budget without a restart past the last burst", async () => {
    const churn = recordingChurn();
    let restarts = 0;
    const result = await churnLoadUntilAborted(
      () => false,
      async () => {
        restarts += 1;
      },
      { ...churn, maxChanges: 1 },
    );
    expect(result).toEqual({
      bursts: DEFAULT_CHURN_BURSTS,
      interfaceChanges: 2 * DEFAULT_CHURN_BURSTS,
    });
    expect(restarts).toBe(DEFAULT_CHURN_BURSTS - 1);
    expect(churn.calls.at(-1)).toBe("link del");
  });
});

describe("serveModuleFanOut", () => {
  test("holds module responses until released and serves the fan-out page", async () => {
    const server = await serveModuleFanOut("Ready title");
    try {
      const page = await get(server.url.href);
      expect(page).toContain("length: 1000");
      expect(page).toContain(JSON.stringify(STARTUP_FAILED_TEXT));
      expect(page).toContain(JSON.stringify("Ready title"));

      let answered = false;
      const held = get(`${server.url.origin}/entry.js?i=0`).then((body) => {
        answered = true;
        return body;
      });
      await server.started;
      expect(server.moduleRequests()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answered).toBe(false);

      server.release();
      expect(await held).toBe("export const ready = true");
      // Released for good: later loads are answered at once.
      expect(await get(`${server.url.origin}/entry.js?i=1`)).toBe("export const ready = true");
      expect(server.moduleRequests()).toBe(2);

      const next = server.nextModuleRequest();
      let nextSeen = false;
      void next.then(() => (nextSeen = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextSeen).toBe(false);
      await get(`${server.url.origin}/entry.js?i=2`);
      await next;
      expect(server.moduleRequests()).toBe(3);
    } finally {
      await server.stop();
    }
  });
});
