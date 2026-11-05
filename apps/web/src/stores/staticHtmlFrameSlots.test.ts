import { beforeEach, describe, expect, test } from "bun:test";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  resetStaticFrameSlots,
  setStaticFrameClaim,
  staticFrameSlotGranted,
  staticFrameSlotStats,
} from "./staticHtmlFrameSlots";

const LIMIT = STATIC_PRESENTATION_POLICY.maxFramesPerWindow;

function fill(prefix = "block"): string[] {
  const ids = Array.from({ length: LIMIT }, (_, index) => `${prefix}-${index}`);
  for (const id of ids) setStaticFrameClaim(id, "visible");
  return ids;
}

beforeEach(() => resetStaticFrameSlots());

describe("static frame slots", () => {
  test("never grants more than the per-window limit", () => {
    for (let index = 0; index < LIMIT * 5; index++) setStaticFrameClaim(`b${index}`, "visible");
    expect(staticFrameSlotStats().granted).toBe(LIMIT);
    expect(staticFrameSlotStats().claims).toBe(LIMIT * 5);
  });

  test("a frame keeps its slot against a newcomer of the same rank", () => {
    const ids = fill();
    setStaticFrameClaim("late", "visible");
    expect(staticFrameSlotGranted("late")).toBe(false);
    for (const id of ids) expect(staticFrameSlotGranted(id)).toBe(true);
  });

  test("a freed slot goes to the waiting block", () => {
    const ids = fill();
    setStaticFrameClaim("late", "visible");
    setStaticFrameClaim(ids[0]!, null);
    expect(staticFrameSlotGranted("late")).toBe(true);
  });

  test("a held frame yields only when another block needs its slot", () => {
    const ids = fill();
    setStaticFrameClaim(ids[0]!, "held");
    expect(staticFrameSlotGranted(ids[0]!)).toBe(true);
    setStaticFrameClaim("next", "visible");
    expect(staticFrameSlotGranted("next")).toBe(true);
    expect(staticFrameSlotGranted(ids[0]!)).toBe(false);
  });

  test("an expanded document takes priority over an inactive visible one", () => {
    const ids = fill();
    setStaticFrameClaim("wide", "expanded");
    expect(staticFrameSlotGranted("wide")).toBe(true);
    expect(staticFrameSlotStats().granted).toBe(LIMIT);
    expect(ids.filter(staticFrameSlotGranted)).toHaveLength(LIMIT - 1);
  });

  test("a frame with focus or a selection outranks a visible one, within the same bound", () => {
    const ids = fill();
    setStaticFrameClaim(ids[3]!, "interacting");
    for (let index = 0; index < LIMIT; index++) setStaticFrameClaim(`new${index}`, "interacting");
    expect(staticFrameSlotStats().granted).toBe(LIMIT);
    expect(staticFrameSlotGranted(ids[3]!)).toBe(true);
    expect(staticFrameSlotGranted(ids[0]!)).toBe(false);
  });

  test("allocation converges back to empty as blocks unmount", () => {
    for (const id of fill()) setStaticFrameClaim(id, null);
    expect(staticFrameSlotStats()).toMatchObject({ claims: 0, granted: 0 });
  });
});
