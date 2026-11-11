import { describe, expect, test } from "bun:test";
import {
  exclusiveOpenCode2Reload,
  openCode2ReloadGateCount,
  openCode2ReloadGateKey,
  withinOpenCode2Dispatch,
} from "./reload-gate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("OpenCode 2 reload gate", () => {
  const key = openCode2ReloadGateKey({ baseUrl: "http://127.0.0.1:1", generation: "g1" });

  test("a reload is refused while a dispatch is open, and runs once it closes", async () => {
    const held = deferred();
    const dispatch = withinOpenCode2Dispatch(key, () => held.promise);
    let ran = false;
    expect(
      await exclusiveOpenCode2Reload(key, async () => {
        ran = true;
        return "reloaded";
      }),
    ).toBe("busy");
    expect(ran).toBe(false);
    held.resolve();
    await dispatch;
    expect(await exclusiveOpenCode2Reload(key, async () => "reloaded")).toBe("reloaded");
    expect(openCode2ReloadGateCount()).toBe(0);
  });

  test("a dispatch waits out a running reload; a second reload is refused", async () => {
    const reloading = deferred();
    const order: string[] = [];
    const reload = exclusiveOpenCode2Reload(key, async () => {
      await reloading.promise;
      order.push("reload");
      return "reloaded";
    });
    const dispatch = withinOpenCode2Dispatch(key, async () => {
      order.push("dispatch");
    });
    expect(await exclusiveOpenCode2Reload(key, async () => "reloaded")).toBe("busy");
    reloading.resolve();
    await Promise.all([reload, dispatch]);
    // The dispatch ran only once the reload it arrived during had finished.
    expect(order).toEqual(["reload", "dispatch"]);
    expect(openCode2ReloadGateCount()).toBe(0);
  });

  test("a failed reload releases the gate and its waiting dispatches", async () => {
    const reload = exclusiveOpenCode2Reload(key, async () => {
      throw new Error("refused");
    });
    const dispatch = withinOpenCode2Dispatch(key, async () => "sent");
    await expect(reload).rejects.toThrow("refused");
    expect(await dispatch).toBe("sent");
    expect(openCode2ReloadGateCount()).toBe(0);
  });

  test("servers are fenced separately", async () => {
    const other = openCode2ReloadGateKey({ baseUrl: "http://127.0.0.1:2", generation: "g1" });
    const held = deferred();
    const dispatch = withinOpenCode2Dispatch(key, () => held.promise);
    expect(await exclusiveOpenCode2Reload(other, async () => "reloaded")).toBe("reloaded");
    held.resolve();
    await dispatch;
  });
});
