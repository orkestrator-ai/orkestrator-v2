import { expect, test } from "bun:test";
import { rpcDelta } from "../../scripts/web3-activity-rpc-live";

test("reports only changed commands, including newly observed hydration calls", () => {
  expect(
    rpcDelta(
      { unchanged: 5, list_prompt_queues: 2 },
      { unchanged: 5, list_prompt_queues: 4, list_multi_review_workflows: 2 },
    ),
  ).toEqual({ list_prompt_queues: 2, list_multi_review_workflows: 2 });
});
test("refuses reset, disappeared and invalid gateway counters", () => {
  const invalid: Record<string, number>[] = [
    { calls: 1 },
    {},
    { calls: Number.NaN },
    { calls: Infinity },
    { calls: -1 },
    { calls: 2.5 },
    { calls: null } as unknown as Record<string, number>,
  ];
  for (const after of invalid) expect(() => rpcDelta({ calls: 2 }, after)).toThrow();
});
