import { expect, test } from "bun:test";
import { isNativeAgentLiveUpdate } from "./native-agent";

const pending = { viewVersion: 1, status: "pending" };
test("combined guard accepts pending parts and rejects malformed envelopes and parts", () => {
  expect(isNativeAgentLiveUpdate({ viewVersion: 1, transcript: pending, state: pending })).toBe(
    true,
  );
  for (const value of [
    null,
    [],
    {},
    { viewVersion: 2, transcript: pending, state: pending },
    { viewVersion: 1, transcript: { ...pending, viewVersion: 2 }, state: pending },
    { viewVersion: 1, transcript: pending, state: { ...pending, viewVersion: 2 } },
    { viewVersion: 1, transcript: {}, state: pending },
    {
      viewVersion: 1,
      transcript: pending,
      state: { viewVersion: 1, status: "snapshot", value: {} },
    },
  ]) {
    expect(isNativeAgentLiveUpdate(value)).toBe(false);
  }
});
