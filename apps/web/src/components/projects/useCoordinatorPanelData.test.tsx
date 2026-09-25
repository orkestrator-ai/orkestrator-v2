import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { CoordinatorSnapshot, ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  dispatchResourceChange,
  requestViewSafetyChecks,
  resetResourceSync,
} from "@/lib/resource-sync";
import {
  flushMicrotasks,
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";
import {
  COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS,
  GIT_STATUS_PROBE_INTERVAL_MS,
  LEGACY_COORDINATOR_POLL_INTERVAL_MS,
  useCoordinatorPanelData,
  type CoordinatorPanelData,
} from "./useCoordinatorPanelData";

const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function git(projectId: string, revision: number, branch = "main"): ProjectGitStatus {
  return { projectId, revision, branch, operationState: "idle" } as unknown as ProjectGitStatus;
}

function coordinator(
  projectId: string,
  title: string,
  repositoryStatus?: ProjectGitStatus,
): CoordinatorSnapshot {
  return {
    workspace: {
      id: `coordinator-${projectId}`,
      projectId,
      conversations: [{ id: "c1", title }],
      ...(repositoryStatus ? { repositoryStatus } : {}),
    },
    projectPath: `/work/${projectId}`,
    providerAvailability: {},
    controlMcp: { enabled: true, running: true, error: null },
    workflows: [],
  } as unknown as CoordinatorSnapshot;
}

/** Stand-in backend: one body per project, stamped by body identity. */
class FakeBackend {
  bodies = new Map<string, CoordinatorSnapshot>();
  statuses = new Map<string, ProjectGitStatus>();
  revisions = new Map<string, { body: CoordinatorSnapshot; revision: number }>();
  nextRevision = 0;
  legacy = false;
  calls: Array<{ command: string; projectId: string; known?: number }> = [];
  ensureGate: Map<string, Promise<void>> = new Map();
  viewGate: Promise<void> | null = null;

  count(command: string, projectId?: string): number {
    return this.calls.filter(
      (call) => call.command === command && (!projectId || call.projectId === projectId),
    ).length;
  }

  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    const projectId = String(args.projectId ?? "");
    this.calls.push({
      command,
      projectId,
      ...(typeof args.knownRevision === "number" ? { known: args.knownRevision } : {}),
    });
    switch (command) {
      case "ensure_project_coordinator": {
        // Captured when the request is served, like the real command.
        const body = this.bodies.get(projectId);
        await this.ensureGate.get(projectId);
        return body;
      }
      case "get_project_coordinator":
        return this.bodies.get(projectId) ?? null;
      case "get_project_coordinator_view": {
        if (this.legacy) throw new Error("Unknown backend command: get_project_coordinator_view");
        const gate = this.viewGate;
        const body = this.bodies.get(projectId)!;
        await gate;
        let tracked = this.revisions.get(projectId);
        if (!tracked || tracked.body !== body) {
          tracked = { body, revision: (this.nextRevision += 1) };
          this.revisions.set(projectId, tracked);
        }
        if (args.knownGeneration === "gen" && args.knownRevision === tracked.revision) {
          return { status: "unchanged", generation: "gen", revision: tracked.revision };
        }
        return {
          status: "snapshot",
          generation: "gen",
          revision: tracked.revision,
          snapshot: body,
        };
      }
      case "get_project_git_status":
      case "fetch_project_git":
        return this.statuses.get(projectId);
      default:
        return undefined;
    }
  }
}

let reads: FakeReadEnvironment;
let fake: FakeBackend;
let latest: CoordinatorPanelData;
let renders = 0;

function Harness({ projectId }: { projectId: string }) {
  latest = useCoordinatorPanelData(projectId);
  renders += 1;
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    await flushMicrotasks();
    await reads.clock.advance(ms);
  });
}

/** Resource changes are delivered after resource-sync's real 50 ms coalescing. */
async function announce(projectId: string) {
  dispatchResourceChange({
    resource: "coordinator",
    id: projectId,
    projectId,
    revision: Date.now(),
  } as never);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await settle();
}

beforeEach(() => {
  reads = installFakeReadCoordinator();
  fake = new FakeBackend();
  renders = 0;
  for (const id of ["p1", "p2"]) {
    fake.bodies.set(id, coordinator(id, `${id} first`));
    fake.statuses.set(id, git(id, 1));
  }
  nativeInvokeMock.mockReset();
  nativeInvokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) =>
    fake.invoke(command, args),
  );
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  resetResourceSync();
});

describe("useCoordinatorPanelData", () => {
  test("a change announced while hydrating is read once the view is live", async () => {
    const gate = deferred<void>();
    fake.ensureGate.set(
      "p1",
      gate.promise.then(() => undefined),
    );
    render(<Harness projectId="p1" />);
    fake.bodies.set("p1", coordinator("p1", "changed during ensure"));
    await announce("p1");
    expect(fake.count("get_project_coordinator_view")).toBe(0);
    gate.resolve();
    await settle();
    await waitFor(() => expect(fake.count("get_project_coordinator_view")).toBe(1));
    await settle();
    expect(latest.snapshot?.workspace.conversations[0]?.title).toBe("changed during ensure");
  });

  test("another client's change arrives by event; an unchanged answer costs no render", async () => {
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.snapshot).not.toBeNull());
    expect(fake.count("get_project_coordinator_view")).toBe(0);

    fake.bodies.set("p1", coordinator("p1", "from another client"));
    await announce("p1");
    expect(fake.count("get_project_coordinator_view")).toBe(1);
    expect(latest.snapshot?.workspace.conversations[0]?.title).toBe("from another client");

    // An event for another project is ignored; a duplicate hint is unchanged.
    await announce("p2");
    expect(fake.count("get_project_coordinator_view")).toBe(1);
    const held = latest.snapshot;
    const rendersBefore = renders;
    await announce("p1");
    expect(fake.count("get_project_coordinator_view")).toBe(2);
    expect(fake.calls.at(-1)?.known).toBeDefined();
    expect(latest.snapshot).toBe(held);
    expect(renders).toBe(rendersBefore);
  });

  test("a missed final event is recovered by the resource-sync safety check", async () => {
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.snapshot).not.toBeNull());
    // The change happened, but its event was lost.
    fake.bodies.set("p1", coordinator("p1", "missed"));
    act(() => requestViewSafetyChecks("interval"));
    await settle();
    expect(fake.count("get_project_coordinator_view")).toBe(1);
    expect(latest.snapshot?.workspace.conversations[0]?.title).toBe("missed");
    // No coordinator polling of its own on a revisioned backend.
    await settle(10 * 60_000);
    expect(fake.count("get_project_coordinator_view")).toBe(1);
  });

  test("switching projects while the old project's reads are in flight never applies them", async () => {
    const gate = deferred<void>();
    fake.ensureGate.set("p1", gate.promise);
    const view = render(<Harness projectId="p1" />);
    view.rerender(<Harness projectId="p2" />);
    await settle();
    await waitFor(() => expect(latest.snapshot?.workspace.projectId).toBe("p2"));
    gate.resolve();
    await settle();
    expect(latest.snapshot?.workspace.projectId).toBe("p2");
    expect(latest.git?.projectId).toBe("p2");

    // A view read for p2 still in flight when switching back to p1 is dropped.
    const viewGate = deferred<void>();
    fake.viewGate = viewGate.promise;
    fake.bodies.set("p2", coordinator("p2", "late"));
    await announce("p2");
    fake.ensureGate.delete("p1");
    view.rerender(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.snapshot?.workspace.projectId).toBe("p1"));
    fake.viewGate = null;
    viewGate.resolve();
    await settle();
    expect(latest.snapshot?.workspace.projectId).toBe("p1");
  });

  test("focus and visibility probe once, and not again within the guard window", async () => {
    let now = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      render(<Harness projectId="p1" />);
      await settle();
      await waitFor(() => expect(latest.git).not.toBeNull());
      const gitReads = fake.count("get_project_git_status");
      now += COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS + 1;
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await settle(1_000);
      expect(fake.count("get_project_git_status")).toBe(gitReads + 1);
      expect(fake.count("get_project_coordinator_view")).toBe(1);
      now += 1_000;
      act(() => window.dispatchEvent(new Event("focus")));
      await settle(1_000);
      expect(fake.count("get_project_git_status")).toBe(gitReads + 1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("repository status: low-frequency visible probe and no fetch per status read", async () => {
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.git).not.toBeNull());
    expect(fake.count("fetch_project_git")).toBe(1);
    const gitReads = fake.count("get_project_git_status");
    fake.statuses.set("p1", git("p1", 2, "external-checkout"));
    await settle(GIT_STATUS_PROBE_INTERVAL_MS);
    expect(fake.count("get_project_git_status")).toBe(gitReads + 1);
    expect(latest.git?.branch).toBe("external-checkout");
    act(() => reads.document.setVisibility("hidden"));
    await settle(GIT_STATUS_PROBE_INTERVAL_MS * 5);
    expect(fake.count("get_project_git_status")).toBe(gitReads + 1);
    // Status reads never fetch.
    expect(fake.count("fetch_project_git")).toBe(1);
  });

  test("a newer status persisted by any client arrives inside the coordinator snapshot", async () => {
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.git?.revision).toBe(1));
    fake.bodies.set("p1", coordinator("p1", "same", git("p1", 5, "switched-elsewhere")));
    await announce("p1");
    expect(latest.git?.branch).toBe("switched-elsewhere");
    // An older persisted status never rolls the panel back.
    fake.bodies.set("p1", coordinator("p1", "same", git("p1", 3, "older")));
    await announce("p1");
    expect(latest.git?.branch).toBe("switched-elsewhere");
  });

  test("a direct answer applied during a view read discards that read's body", async () => {
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.snapshot).not.toBeNull());
    const viewGate = deferred<void>();
    fake.viewGate = viewGate.promise;
    await announce("p1");
    expect(fake.count("get_project_coordinator_view")).toBe(1);
    const direct = coordinator("p1", "from a mutation");
    act(() => latest.applySnapshot(direct));
    fake.bodies.set("p1", direct);
    fake.viewGate = null;
    viewGate.resolve();
    await settle();
    // The stale body was not applied; a fresh conditional read followed.
    expect(fake.count("get_project_coordinator_view")).toBe(2);
    expect(latest.snapshot?.workspace.conversations[0]?.title).toBe("from a mutation");
  });

  test("an older backend keeps the conservative full poll", async () => {
    fake.legacy = true;
    render(<Harness projectId="p1" />);
    await settle();
    await waitFor(() => expect(latest.snapshot).not.toBeNull());
    await announce("p1");
    expect(fake.count("get_project_coordinator")).toBe(1);
    fake.bodies.set("p1", coordinator("p1", "legacy poll"));
    await settle(LEGACY_COORDINATOR_POLL_INTERVAL_MS);
    expect(fake.count("get_project_coordinator")).toBe(2);
    expect(latest.snapshot?.workspace.conversations[0]?.title).toBe("legacy poll");
    expect(fake.count("get_project_coordinator_view")).toBe(1);
  });
});
