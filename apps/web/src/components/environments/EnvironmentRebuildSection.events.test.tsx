/**
 * The rebuild section follows a rebuild through the backend's pushed
 * `container-lifecycle-updated` events instead of reading the snapshot every
 * two seconds. Reads remain the authority on subscribe and after a resync, and
 * a slow backstop read runs while a rebuild is in flight.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  CONTAINER_LIFECYCLE_EVENT,
  type ContainerLifecycleEvent,
  type ContainerLifecycleSnapshot,
} from "@orkestrator/protocol/container-lifecycle";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import * as events from "@/lib/native/events";
import type { Environment } from "@/types";
import {
  EnvironmentRebuildSection,
  REBUILD_BACKSTOP_POLL_MS,
  REBUILD_POLL_MS,
} from "./EnvironmentRebuildSection";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const environment = {
  id: "env-rebuild-events",
  name: "Rebuild events",
  environmentType: "containerized",
  containerId: "container-1",
  status: "running",
} as unknown as Environment;

function snapshot(
  revision: number,
  phase: string | null,
  status: "running" | "succeeded" = "running",
): ContainerLifecycleSnapshot {
  return {
    revision,
    supported: true,
    runtimeGeneration: 1,
    imageId: null,
    storageFormat: "volume-v1",
    workspaceGeneration: 1,
    operation:
      phase === null
        ? null
        : {
            operationId: "op-1",
            kind: "rebuild",
            status,
            phase,
            startedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            failureCode: null,
          },
    lastOutcome: null,
    bootPhase: null,
  };
}

let listeners: Map<string, Set<(payload: unknown) => void>>;
let reads: number;
let current: ContainerLifecycleSnapshot;

function emit(event: string, payload?: unknown) {
  act(() => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  });
}

function emitLifecycle(environmentId: string, next: ContainerLifecycleSnapshot) {
  emit(CONTAINER_LIFECYCLE_EVENT, {
    environmentId,
    snapshot: next,
  } satisfies ContainerLifecycleEvent);
}

const POLL_DELAYS = new Set<unknown>([REBUILD_POLL_MS, REBUILD_BACKSTOP_POLL_MS]);

/** The section's own poll intervals, leaving out the test library's timers. */
function pollDelays(intervals: { mock: { calls: unknown[][] } }): unknown[] {
  return intervals.mock.calls.map(([, delay]) => delay).filter((delay) => POLL_DELAYS.has(delay));
}

function section(nextEnvironment = environment) {
  return (
    <EnvironmentRebuildSection
      environment={nextEnvironment}
      dockerAvailable
      onRestart={async () => undefined}
      beforeRebuild={async () => undefined}
      onUpdate={() => undefined}
      onClose={() => undefined}
    />
  );
}

function renderSection() {
  return render(section());
}

beforeEach(() => {
  listeners = new Map();
  reads = 0;
  current = snapshot(1, null);
  spyOn(events, "listen").mockImplementation(async (event, handler, options) => {
    const wrapped = (payload: unknown) => handler({ payload } as never);
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    set.add(wrapped);
    const unlisten = () => {
      set.delete(wrapped);
    };
    options?.signal?.addEventListener("abort", unlisten, { once: true });
    return unlisten;
  });
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_container_lifecycle_snapshot") {
      reads += 1;
      return current;
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  mock.restore();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("environment rebuild section lifecycle events", () => {
  test("follows a rebuild from events, ignoring other environments and stale revisions", async () => {
    renderSection();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("status")).toBeNull();

    emitLifecycle(environment.id, snapshot(2, "preflight"));
    await screen.findByText(/Checking image and free space/);

    emitLifecycle("another-environment", snapshot(9, "copying"));
    expect(screen.queryByText(/Copying and verifying files/)).toBeNull();

    emitLifecycle(environment.id, snapshot(4, "copying"));
    await screen.findByText(/Copying and verifying files/);
    // An event published before the one already shown must not roll it back.
    emitLifecycle(environment.id, snapshot(3, "quiescing"));
    expect(screen.getByText(/Copying and verifying files/)).toBeTruthy();

    emitLifecycle(environment.id, snapshot(5, null));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    // Every step after the first read came from events.
    expect(reads).toBe(1);
  });

  test("a transport resync re-reads the snapshot", async () => {
    renderSection();
    await waitFor(() => expect(reads).toBe(1));

    current = snapshot(7, "copying");
    emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
    await screen.findByText(/Copying and verifying files/);
    expect(reads).toBe(2);
  });

  test("a read that resolves after a newer event keeps the newer snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    current = snapshot(1, "preflight");
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_container_lifecycle_snapshot") return undefined;
      reads += 1;
      const answer = current;
      await gate;
      return answer;
    });
    renderSection();
    await waitFor(() => expect(reads).toBe(1));

    emitLifecycle(environment.id, snapshot(3, "copying"));
    await screen.findByText(/Copying and verifying files/);
    await act(async () => {
      release();
      await gate;
    });
    expect(screen.getByText(/Copying and verifying files/)).toBeTruthy();
  });

  test("switching environments ignores late reads and events from the old subscription", async () => {
    let release!: (value: ContainerLifecycleSnapshot) => void;
    const late = new Promise<ContainerLifecycleSnapshot>((resolve) => {
      release = resolve;
    });
    const nextEnvironment = { ...environment, id: "env-next" };
    invokeMock.mockImplementation(async (command: string, args: { environmentId: string }) => {
      if (command !== "get_container_lifecycle_snapshot") return undefined;
      reads += 1;
      return args.environmentId === environment.id && reads > 1 ? late : snapshot(1, "preflight");
    });
    const view = renderSection();
    await screen.findByText(/Checking image and free space/);
    emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT);
    await waitFor(() => expect(reads).toBe(2));
    const oldHandlers = Array.from(listeners.get(CONTAINER_LIFECYCLE_EVENT) ?? []);
    view.rerender(section(nextEnvironment));
    await waitFor(() => expect(reads).toBe(3));
    emitLifecycle(nextEnvironment.id, snapshot(3, "copying"));
    await screen.findByText(/Copying and verifying files/);
    await act(async () => {
      release(snapshot(99, "quiescing"));
      await late;
      for (const handler of oldHandlers)
        handler({ environmentId: environment.id, snapshot: snapshot(100, "quiescing") });
    });
    expect(screen.getByText(/Copying and verifying files/)).toBeTruthy();
    emitLifecycle(nextEnvironment.id, snapshot(4, null));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  test("polls only as a slow backstop while a rebuild runs with events live", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    current = snapshot(1, "copying");
    renderSection();
    await screen.findByText(/Copying and verifying files/);

    await waitFor(() => expect(pollDelays(intervals)).toContain(REBUILD_BACKSTOP_POLL_MS));
    const delays = pollDelays(intervals);
    // The quick poll can only have run before the subscription was confirmed.
    expect(delays.at(-1)).toBe(REBUILD_BACKSTOP_POLL_MS);
    expect(REBUILD_BACKSTOP_POLL_MS).toBeGreaterThan(REBUILD_POLL_MS);
  });

  test("keeps the quick poll when the event subscription fails", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    spyOn(events, "listen").mockImplementation(async () => {
      throw new Error("transport closed");
    });
    current = snapshot(1, "copying");
    renderSection();
    await screen.findByText(/Copying and verifying files/);

    const delays = pollDelays(intervals);
    expect(delays).toContain(REBUILD_POLL_MS);
    expect(delays).not.toContain(REBUILD_BACKSTOP_POLL_MS);
  });
});
