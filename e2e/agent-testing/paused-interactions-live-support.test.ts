import { expect, test } from "bun:test";
import type { AgentInteractionQuestion } from "@orkestrator/protocol/agent-interactions";
import {
  approvalOption,
  raiseAndProtect,
  withEnvironmentCleanup,
} from "./paused-interactions-live-support";

function question(labels: string[], required = true): AgentInteractionQuestion {
  return {
    id: "approval",
    prompt: "Approve?",
    required,
    multiple: false,
    secret: false,
    allowFreeText: false,
    options: labels.map((label, index) => ({
      id: String(index),
      providerValue: String(index),
      label,
    })),
  };
}

test("optional policy choices and missing questions require no selection", () => {
  expect(approvalOption(undefined)).toBeUndefined();
  expect(approvalOption(question(["Approve with command policy"], false))).toBeUndefined();
});

test("allow once takes precedence over generic approval and broader grants", () => {
  const input = question([
    "Always allow",
    "Allow this session",
    "Approve",
    "Approve once",
    "Deny once",
  ]);
  expect(approvalOption(input)?.label).toBe("Approve once");
});

test("amendments are excluded even when labelled allow once", () => {
  const input = question(["Allow once", "Approve"]);
  input.options[0]!.amendment = { kind: "exec-policy", detail: "Remember command" };
  expect(approvalOption(input)?.label).toBe("Approve");
});

for (const labels of [
  [],
  ["Deny once", "Reject", "No"],
  ["Always allow", "Allow session", "Approve with policy"],
  ["Unknown"],
]) {
  test(`required unsafe or absent choices fail closed: ${labels.join(", ")}`, () => {
    expect(() => approvalOption(question(labels))).toThrow("No safe allow-once option");
  });
}

for (const failedStage of ["start_environment", "save_pane_layout"]) {
  test(`a ${failedStage} failure after creation still stops and deletes the environment`, async () => {
    const environments = new Set<string>();
    const commands: string[] = [];
    await expect(
      withEnvironmentCleanup(
        async (command, { environmentId }) => {
          commands.push(command);
          if (command === "delete_environment") environments.delete(environmentId);
        },
        async (register) => {
          // Creation succeeded; the initialized run record never exists.
          environments.add("created");
          register("created");
          throw new Error(`${failedStage} failed`);
        },
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(commands).toEqual(["stop_environment", "delete_environment"]);
    expect(environments.size).toBe(0);
  });
}

test("cleanup drains all IDs in reverse order despite stop/delete failures", async () => {
  const commands: string[] = [];
  await expect(
    withEnvironmentCleanup(
      async (command, { environmentId }) => {
        commands.push(`${command}:${environmentId}`);
        if (environmentId === "second") throw new Error("cleanup failed");
      },
      async (register) => {
        register("first");
        register("second");
      },
    ),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(commands).toEqual([
    "stop_environment:second",
    "delete_environment:second",
    "stop_environment:first",
    "delete_environment:first",
  ]);
});

test("successful qualification also removes every environment", async () => {
  const commands: string[] = [];
  expect(
    await withEnvironmentCleanup(
      async (command) => {
        commands.push(command);
      },
      async (register) => {
        register("created");
        return "qualified";
      },
    ),
  ).toBe("qualified");
  expect(commands).toEqual(["stop_environment", "delete_environment"]);
});

test("early requests are held before a slow sibling or another provider can use up their deadline", async () => {
  const events: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = raiseAndProtect(
    [["early", "slow-sibling"], ["slow-provider"]],
    async (item) => {
      if (item !== "early") await slow;
      events.push(`raised:${item}`);
    },
    async (item) => {
      events.push(`held:${item}`);
    },
  );
  // Advance microtasks until the early case is protected, leaving both slow
  // raises unresolved for as long as needed (even beyond the original expiry).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["raised:early", "held:early"]);
  release();
  await pending;
  expect(events.indexOf("held:early")).toBeLessThan(events.indexOf("raised:slow-sibling"));
  expect(events.indexOf("held:early")).toBeLessThan(events.indexOf("raised:slow-provider"));
  expect(events.filter((event) => event.startsWith("held:"))).toHaveLength(3);
});

test("a failed provider drains its sibling before returning to cleanup", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = false;
  let protectedSibling = false;
  const pending = raiseAndProtect(
    [["failed"], ["slow"]],
    async (item) => {
      if (item === "failed") throw new Error("provider failed");
      await slow;
    },
    async () => {
      protectedSibling = true;
    },
  ).catch(() => {
    returned = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(returned).toBe(false);
  release();
  await pending;
  expect(protectedSibling).toBe(true);
  expect(returned).toBe(true);
});
