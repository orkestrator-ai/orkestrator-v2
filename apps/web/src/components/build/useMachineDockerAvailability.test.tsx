import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import type { AccountMachine } from "@/lib/backend/client";
import { useMachineDockerAvailability } from "./useMachineDockerAvailability";

interface Pending {
  nodeId: string;
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const routed = spyOn(portalStore, "invokeOnNode");
const pending: Pending[] = [];

beforeEach(() => {
  pending.length = 0;
  routed.mockReset();
  routed.mockImplementation(
    ((nodeId: unknown, command: string) =>
      new Promise((resolve, reject) => {
        pending.push({ nodeId: String(nodeId), command, resolve, reject });
      })) as unknown as typeof portalStore.invokeOnNode,
  );
});

afterEach(() => {
  cleanup();
});

function render(machine: AccountMachine, enabled = true) {
  return renderHookInAppCommandScope(
    ({ machine: target, enabled: on }: { machine: AccountMachine; enabled: boolean }) =>
      useMachineDockerAvailability(target, on),
    { initialProps: { machine, enabled } },
  );
}

async function settle(entry: Pending, outcome: { value?: unknown; error?: unknown }) {
  await act(async () => {
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
    await Promise.resolve();
  });
}

describe("useMachineDockerAvailability", () => {
  test("asks nothing for this tab's own machine", () => {
    const { result } = render("builder", false);
    expect(result.current === null).toBe(true);
    expect(routed).not.toHaveBeenCalled();
  });

  test("is unknown while the other machine has not answered, then reports its answer", async () => {
    const { result } = render("builder");
    expect(result.current === null).toBe(true);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.nodeId).toBe("builder");

    await settle(pending[0]!, { value: { available: true } });
    expect(result.current).toBe(true);
  });

  test("an answer without Docker is false", async () => {
    const { result } = render("builder");
    await settle(pending[0]!, { value: { available: false } });
    expect(result.current).toBe(false);
  });

  test("an unreadable answer fails closed to false", async () => {
    const { result } = render("builder");
    await settle(pending[0]!, { error: new Error("unreachable") });
    expect(result.current).toBe(false);
  });

  test("a late answer for a previous machine is not applied to the new one", async () => {
    const { result, rerender } = render("builder");
    rerender({ machine: "laptop", enabled: true });
    expect(pending.map((entry) => entry.nodeId)).toEqual(["builder", "laptop"]);

    await settle(pending[0]!, { value: { available: true } });
    expect(result.current === null).toBe(true);

    await settle(pending[1]!, { value: { available: false } });
    expect(result.current).toBe(false);
  });

  test("an answer that arrives after unmount is dropped", async () => {
    const { result, unmount } = render("builder");
    unmount();
    await settle(pending[0]!, { value: { available: true } });
    expect(result.current === null).toBe(true);
  });
});
