import { afterEach, describe, expect, test } from "bun:test";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { richBlockViewKey } from "@/lib/chat/rich-identity";
import {
  clearRichViewEnvironment,
  pinRichViewKey,
  retainRichViewKey,
  useRichContentViewStore,
} from "./richContentViewStore";

const scope = (backendId: string, environmentId: string) => ({
  backendId,
  environmentId,
  logicalSessionKey: `env-${environmentId}:tab`,
  generation: "g",
});

afterEach(() => useRichContentViewStore.getState().reset());

describe("rich content view store", () => {
  test("identical message/part ids in two backends or environments never share state", () => {
    const update = useRichContentViewStore.getState().update;
    const a = richBlockViewKey(scope("backend-a", "env-1"), "m1", "p1", "b1");
    const b = richBlockViewKey(scope("backend-b", "env-1"), "m1", "p1", "b1");
    const c = richBlockViewKey(scope("backend-a", "env-2"), "m1", "p1", "b1");
    update(a, { open: true });
    const entries = useRichContentViewStore.getState().entries;
    expect(entries.get(a)?.open).toBe(true);
    expect(entries.get(b)).toBeUndefined();
    expect(entries.get(c)).toBeUndefined();
  });

  test("evicts inactive entries beyond the bound but never mounted ones", () => {
    const update = useRichContentViewStore.getState().update;
    const mounted = richBlockViewKey(scope("b", "e"), "m-mounted", "p", "b");
    const release = retainRichViewKey(mounted);
    update(mounted, { open: true });
    for (let i = 0; i < FRONTEND_RENDER_POLICY.maxInactiveViewStateEntries + 25; i++) {
      update(richBlockViewKey(scope("b", "e"), `m${i}`, "p", "b"), { open: true });
    }
    const entries = useRichContentViewStore.getState().entries;
    expect(entries.size).toBeLessThanOrEqual(
      FRONTEND_RENDER_POLICY.maxInactiveViewStateEntries + 1,
    );
    expect(entries.get(mounted)?.open).toBe(true);
    release();
  });

  test("pins are bounded and report the displaced pin", () => {
    const releases = [];
    let displaced: string | null = null;
    for (let i = 0; i <= FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries; i++) {
      const pin = pinRichViewKey(`pin-${i}`);
      releases.push(pin.release);
      displaced = pin.displaced ?? displaced;
    }
    expect(displaced).toBe("pin-0");
    for (const release of releases) release();
  });

  test("deleting an environment clears only that environment's entries", () => {
    const update = useRichContentViewStore.getState().update;
    const keep = richBlockViewKey(scope("b", "env-keep"), "m", "p", "b");
    const drop = richBlockViewKey(scope("b", "env-drop"), "m", "p", "b");
    update(keep, { wrap: true });
    update(drop, { wrap: true });
    clearRichViewEnvironment("env-drop");
    const entries = useRichContentViewStore.getState().entries;
    expect(entries.has(keep)).toBe(true);
    expect(entries.has(drop)).toBe(false);
  });
});
