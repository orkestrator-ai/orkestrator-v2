import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { startCoordinatedPoll } from "./coordinated-poll";
import {
  readCoordinatorFor,
  resetReadCoordinatorForTests,
  READ_RESUME_COALESCE_MS,
} from "./read-coordinator";
import { flushMicrotasks, installFakeReadCoordinator } from "./testing/read-coordinator";

afterEach(() => resetReadCoordinatorForTests());

/** Longest a `standard` read can wait after the window returns, with `random: 0`. */
const RESUME_MS = READ_RESUME_COALESCE_MS + 100;

function startPoll(intervalMs: number) {
  const environment = installFakeReadCoordinator();
  const reads: number[] = [];
  const stop = startCoordinatedPoll({
    resource: "test-poll",
    intervalMs,
    read: () => {
      reads.push(environment.clock.time);
    },
  });
  return { ...environment, reads, stop };
}

describe("startCoordinatedPoll", () => {
  test("reads on the interval, and not at the start", async () => {
    const { clock, reads } = startPoll(3_000);
    await flushMicrotasks();
    expect(reads).toEqual([]);
    await clock.advance(9_000);
    expect(reads).toEqual([3_000, 6_000, 9_000]);
  });

  test("stops while the window is hidden and reads once on its return", async () => {
    const { clock, document, reads } = startPoll(3_000);
    await clock.advance(3_000);
    expect(reads).toHaveLength(1);

    document.setVisibility("hidden");
    // A plain 3 s interval would have read 200 times here.
    await clock.advance(600_000);
    expect(reads).toHaveLength(1);
    expect(clock.pending).toBe(0);

    document.setVisibility("visible");
    await clock.advance(RESUME_MS);
    expect(reads).toHaveLength(2);

    // Back on its cadence, from that read.
    await clock.advance(3_000);
    expect(reads).toHaveLength(3);
  });

  test("a return before the interval has passed reads nothing extra", async () => {
    const { clock, document, reads } = startPoll(60_000);
    await clock.advance(10_000);
    document.setVisibility("hidden");
    await clock.advance(5_000);
    document.setVisibility("visible");
    await clock.advance(RESUME_MS);
    expect(reads).toEqual([]);
    await clock.advance(60_000);
    expect(reads).toEqual([60_000]);
  });

  test("hidden from the start, it reads only after the window shows", async () => {
    const environment = installFakeReadCoordinator();
    environment.document.setVisibility("hidden");
    let reads = 0;
    startCoordinatedPoll({ resource: "test-poll", intervalMs: 400, read: () => void (reads += 1) });
    await environment.clock.advance(10_000);
    expect(reads).toBe(0);
    environment.document.setVisibility("visible");
    await environment.clock.advance(READ_RESUME_COALESCE_MS + 300);
    expect(reads).toBe(1);
  });

  test("critical polls are read first on return", async () => {
    const environment = installFakeReadCoordinator({ random: () => 1 });
    const order: string[] = [];
    for (const [resource, priority] of [
      ["auxiliary", "auxiliary"],
      ["standard", "standard"],
      ["critical", "critical"],
    ] as const) {
      startCoordinatedPoll({
        resource,
        intervalMs: 400,
        priority,
        read: () => void order.push(resource),
      });
    }
    environment.document.setVisibility("hidden");
    await environment.clock.advance(1_000);
    environment.document.setVisibility("visible");
    await environment.clock.advance(READ_RESUME_COALESCE_MS);
    expect(order).toEqual(["critical"]);
  });

  test("stops while the transport is disconnected, and reads on reconnect", async () => {
    const { clock, coordinator, reads } = startPoll(3_000);
    coordinator.setDisconnected(true);
    await clock.advance(30_000);
    expect(reads).toEqual([]);
    coordinator.setDisconnected(false);
    await clock.advance(RESUME_MS);
    expect(reads).toHaveLength(1);
  });

  test("the stop function ends it, and leaves nothing in the coordinator", async () => {
    const { clock, coordinator, reads, stop } = startPoll(3_000);
    await clock.advance(3_000);
    stop();
    await clock.advance(30_000);
    expect(reads).toHaveLength(1);
    expect(coordinator.getDiagnostics().entries).toEqual([]);
  });

  test("a tick landing during a slow read is skipped", async () => {
    const environment = installFakeReadCoordinator();
    let reads = 0;
    let finish: () => void = () => undefined;
    startCoordinatedPoll({
      resource: "test-poll",
      intervalMs: 1_000,
      read: () =>
        new Promise<void>((resolve) => {
          reads += 1;
          finish = resolve;
        }),
    });
    await environment.clock.advance(5_500);
    expect(reads).toBe(1);
    finish();
    await flushMicrotasks();
    await environment.clock.advance(500);
    expect(reads).toBe(2);
  });

  test("a failed read logs and keeps the same interval", async () => {
    const environment = installFakeReadCoordinator();
    const logs = captureLogs();
    const times: number[] = [];
    startCoordinatedPoll({
      resource: "test-poll",
      intervalMs: 2_000,
      read: () => {
        times.push(environment.clock.time);
        throw new Error("read failed");
      },
    });
    await environment.clock.advance(6_000);
    logs.restore();
    expect(times).toEqual([2_000, 4_000, 6_000]);
    expect(logs.lines.filter((line) => line.includes("poll.read-failed"))).toHaveLength(3);
  });

  test("polls of one resource never share a read", async () => {
    const environment = installFakeReadCoordinator();
    const reads = { first: 0, second: 0 };
    startCoordinatedPoll({ resource: "same", intervalMs: 1_000, read: () => void reads.first++ });
    startCoordinatedPoll({ resource: "same", intervalMs: 1_000, read: () => void reads.second++ });
    await environment.clock.advance(1_000);
    expect(reads).toEqual({ first: 1, second: 1 });
  });
});

describe("the polls WEB-18 names", () => {
  // Each runs through the coordinator, so the tests above apply to all of them.
  // Reads the source because several sit in components that need a whole
  // backend to mount; the owning tests cover what each one does on a tick.
  const SITES: Record<string, string[]> = {
    "App.tsx": ["docker-availability"],
    "hooks/useUserCommands.ts": ["user-commands"],
    "components/browser/annotations/useAnnotationCapture.ts": ["annotation-selection"],
    "components/docker/DockerSettings.tsx": ["docker-settings-probe", "docker-settings-stats"],
    "components/docker/DockerImageStatusPanel.tsx": ["docker-image-task"],
    "components/environments/EnvironmentRecoveryCopies.tsx": ["environment-recovery-copies"],
    "components/environments/EnvironmentRebuildSection.tsx": ["environment-rebuild"],
    "components/federation/ProjectCopyDialog.tsx": ["project-copy"],
    "components/settings/machines/useMachineMaintenance.ts": ["machine-maintenance"],
    "components/bug-report/BugReportSheet.tsx": ["bug-report-draft"],
    "components/github/GitHubCliSetup.tsx": ["github-cli-login"],
    "components/review/useMultiReviewPrPhase.ts": ["multi-review-pr-phase"],
  };

  for (const [file, resources] of Object.entries(SITES)) {
    test(`${file} polls through the coordinator`, () => {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      for (const resource of resources) expect(source).toContain(`resource: "${resource}"`);
      if (file !== "components/browser/annotations/useAnnotationCapture.ts") {
        expect(source).not.toMatch(/\bsetInterval\(/);
      }
    });
  }

  test("the annotation file's only interval left is its upload retry", () => {
    const source = readFileSync(
      join(import.meta.dir, "../components/browser/annotations/useAnnotationCapture.ts"),
      "utf8",
    );
    expect(source.match(/\bsetInterval\(/g)).toHaveLength(1);
    expect(source).toMatch(/setInterval\(\s*\(\) => void resumeRef/);
  });
});

describe("startCoordinatedPoll per scope", () => {
  test("schedules on the named scope's coordinator, so that node's outage pauses it", () => {
    const windowScope = new WindowScope();
    try {
      const leaf = windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "bk_leaf" as BackendId }),
      });
      const stop = startCoordinatedPoll({
        resource: "leaf-poll",
        intervalMs: 60_000,
        read: () => undefined,
        scope: leaf,
      });
      const diagnostics = readCoordinatorFor(leaf).getDiagnostics();
      expect(diagnostics.entries.map((entry) => entry.id)).toEqual([
        expect.stringContaining("leaf-poll"),
      ]);
      stop();
      expect(readCoordinatorFor(leaf).getDiagnostics().entries).toEqual([]);
    } finally {
      windowScope.dispose();
    }
  });
});
