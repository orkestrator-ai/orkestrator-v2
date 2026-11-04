import { expect, test } from "bun:test";
import type { AgentSessionAccount } from "@orkestrator/protocol/agent-accounts";
import { usageLimitAccountRouting } from "./coordinator-usage-limit-account-routing.js";

test("production routing matches next-turn identity and passes matching accounts to automatic move", async () => {
  const account = {
    id: "entry",
    platform: "claude",
    identity: { email: "limited@example.com" },
  } as const;
  let live = false;
  const routing = usageLimitAccountRouting({
    readSession: async () =>
      ({
        platform: "claude",
        source: "account",
        running: true,
        account,
        pendingActive: { ...account, identity: { email: "next@example.com" } },
      }) as unknown as AgentSessionAccount,
    hasLiveWork: async () => live,
    machineKey: async () => "machine",
    switcher: {
      moveOffLimitedAccount: async (platform, matches, options) => {
        expect(platform).toBe("claude");
        expect(options?.quietProjectId).toBe("project");
        expect(matches(account as never)).toBe(true);
        expect(matches({ ...account, identity: { email: "other@example.com" } } as never)).toBe(
          false,
        );
        return { moved: true, to: "other" };
      },
    },
  });
  const key = await routing.coordinatorAccountKey("coordinator:one:main", "claude");
  expect(key).toBe("claude:email:next@example.com");
  live = true;
  expect(await routing.coordinatorAccountKey("coordinator:one:main", "claude")).toBe(
    "claude:email:limited@example.com",
  );
  expect(
    await routing.moveOff("claude", "claude:email:limited@example.com", {
      quietProjectId: "project",
    }),
  ).toEqual({
    moved: true,
    to: "other",
  });
  expect(await routing.moveOff("grok", key!, {})).toEqual({
    moved: false,
    reason: "no-account-with-headroom",
  });
});
