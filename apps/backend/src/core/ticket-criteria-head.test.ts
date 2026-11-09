import { describe, expect, test } from "bun:test";
import { installControlledTimeout } from "../../../../tests/helpers/controlled-timeout.js";
import type { CommandInvoker } from "./control-shared-actions.js";
import { criteriaEnvironmentHead } from "./ticket-criteria-head.js";

const HEAD = "a".repeat(40);
const task = {
  environmentId: "env-1",
  sections: { acceptanceCriteria: [{ check: { commit: HEAD } }] },
};

function pendingRead() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const invoke: CommandInvoker = async <T>(command: string, args?: Record<string, unknown>) => {
    expect(command).toBe("get_environment_uncommitted_paths");
    expect(args).toEqual({ environmentId: "env-1" });
    return (await promise) as T;
  };
  return { invoke, resolve, reject };
}

describe("criteriaEnvironmentHead deadline", () => {
  test.each(["resolve", "reject"] as const)(
    "falls back at five seconds and safely handles a late %s",
    async (outcome) => {
      const clock = installControlledTimeout(5_000);
      const pending = pendingRead();
      try {
        const read = criteriaEnvironmentHead(pending.invoke, task);
        expect(clock.pendingCount()).toBe(1);
        expect(clock.advance()).toBe(1);
        expect(await read).toBeUndefined();
        if (outcome === "resolve") pending.resolve({ head: HEAD });
        else pending.reject(new Error("Environment unavailable"));
        await Promise.resolve();
        expect(await read).toBeUndefined();
        expect(clock.pendingCount()).toBe(0);
      } finally {
        clock.restore();
      }
    },
  );

  test.each(["resolve", "reject"] as const)(
    "clears the deadline after an early %s",
    async (outcome) => {
      const clock = installControlledTimeout(5_000);
      const pending = pendingRead();
      try {
        const read = criteriaEnvironmentHead(pending.invoke, task);
        expect(clock.pendingCount()).toBe(1);
        if (outcome === "resolve") pending.resolve({ head: HEAD.toUpperCase() });
        else pending.reject(new Error("Environment unavailable"));
        expect(await read).toBe(outcome === "resolve" ? HEAD : undefined);
        expect(clock.pendingCount()).toBe(0);
        expect(clock.advance()).toBe(0);
      } finally {
        clock.restore();
      }
    },
  );
});
