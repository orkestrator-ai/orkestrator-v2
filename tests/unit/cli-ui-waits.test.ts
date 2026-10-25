import { expect, test } from "bun:test";
import { pendingInteractionIds, waitPastResolved } from "../../e2e/agent-testing/cli-ui-waits";

function result(code: number, ids?: string[]) {
  return {
    code,
    envelope: {
      ok: true,
      ...(ids ? { receipt: { execution: { interactions: ids.map((id) => ({ id })) } } } : {}),
    },
  };
}

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    async sleep(ms: number) {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

test("retries answered interactions until the run settles", async () => {
  const time = clock();
  const replies = [result(6, ["answered"]), result(6, ["answered"]), result(0)];
  const calls: number[] = [];
  const settled = await waitPastResolved(
    () => {
      calls.push(time.now());
      return replies.shift()!;
    },
    new Set(["answered"]),
    time,
  );
  expect(settled.code).toBe(0);
  expect(calls).toEqual([0, 1_000, 2_000]);
  expect(time.sleeps).toEqual([1_000, 1_000]);
});

test("stops retrying at the 60-second deadline", async () => {
  const time = clock();
  const pending = result(6, ["answered"]);
  let calls = 0;
  expect(
    await waitPastResolved(
      () => {
        calls++;
        return pending;
      },
      new Set(["answered"]),
      time,
    ),
  ).toBe(pending);
  expect(time.now()).toBe(60_000);
  expect(calls).toBe(61);
  expect(time.sleeps).toHaveLength(60);
});

for (const [name, reply] of [
  ["empty pending", result(6, [])],
  ["missing receipt", result(6)],
  ["new interaction", result(6, ["new"])],
  ["mixed answered and new", result(6, ["answered", "new"])],
  ["failure", result(1, ["answered"])],
  ["success", result(0)],
] as const) {
  test(`returns immediately for ${name}`, async () => {
    const time = clock();
    let calls = 0;
    expect(
      await waitPastResolved(
        () => {
          calls++;
          return reply;
        },
        new Set(["answered"]),
        time,
      ),
    ).toBe(reply);
    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });
}

test("missing interaction arrays are empty", () => {
  expect(pendingInteractionIds({ ok: true, receipt: {} })).toEqual([]);
  expect(pendingInteractionIds({ ok: true, receipt: { execution: {} } })).toEqual([]);
});
