import { afterEach, describe, expect, test } from "bun:test";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OPERATION = "op-1790000000000-0a1b2c3d-000000000000000009";

function receipt(overrides: Partial<PublicReceipt>): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: OPERATION,
    action: "host.update.apply",
    ...overrides,
  };
}

function host(version: string): HostMaintenanceSnapshot {
  return hostMaintenanceSnapshotFixture({
    revision: 3,
    version,
    updater: {
      kind: "desktop",
      available: true,
      reason: null,
      latestVersion: "2.22.0",
      updateAvailable: version !== "2.22.0",
      checkedAt: "2026-10-16T12:00:00.000Z",
      checkError: null,
    },
  });
}

/** A backend that accepts the update, goes away while restarting, then reports `final`. */
async function fixture(
  final: PublicReceipt,
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  let reads = 0;
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    if (action === "host.update.apply") {
      return envelope(
        publicSuccessEnvelope(
          "host.update.apply",
          { jobId: "hostupd-1", fromVersion: "2.21.1" },
          receipt({ state: "running", stage: "requested", completedAt: undefined }),
        ),
      );
    }
    if (action === "run.get") {
      reads += 1;
      // A proxy's 502 while the backend is down, then its shutdown error.
      if (reads === 1) return new Response("restarting", { status: 502 });
      if (reads === 2) return Response.json({ error: "Backend is shutting down" }, { status: 500 });
      return envelope(publicSuccessEnvelope("run.get", null, final));
    }
    if (action === "host.update.channel") {
      return envelope(
        publicSuccessEnvelope(
          action,
          {
            host: {
              ...host("2.22.0"),
              updateChannel: (request.body.args.input as { channel: string }).channel,
            },
          },
          receipt({ action, state: "succeeded", stage: "completed" }),
        ),
      );
    }
    if (action === "host.status") {
      return envelope(publicSuccessEnvelope("host.status", host("2.22.0")));
    }
    if (action === "host.update.cancel") {
      return envelope(
        publicSuccessEnvelope(
          "host.update.cancel",
          { jobId: "hostupd-1", state: "cancelled" },
          receipt({ action: "host.update.cancel", state: "succeeded", stage: "completed" }),
        ),
      );
    }
    if (action === "host.toolchain.repair" || action === "host.gh.update") {
      return envelope(
        publicSuccessEnvelope(
          action,
          { taskId: "task-1" },
          receipt({ action, state: "running", stage: "running", completedAt: undefined }),
        ),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

function actions(gateway: FakeGateway): string[] {
  return gateway.requests.map((request) => String(request.body.args.action));
}

describe("orkestrator host update apply", () => {
  test("refuses to run without --yes and sends nothing", async () => {
    const { box, gateway } = await fixture(receipt({ state: "succeeded", stage: "completed" }));
    const result = await box.run(["host", "update", "apply"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--yes");
    expect(actions(gateway)).not.toContain("host.update.apply");
  });

  test("--wait follows the update through the backend restart", async () => {
    const { box, gateway } = await fixture(receipt({ state: "succeeded", stage: "completed" }));
    const result = await box.run([
      "host",
      "update",
      "apply",
      "--yes",
      "--wait",
      "--output",
      "json",
    ]);
    expect(result.code).toBe(0);
    const apply = gateway.requests.find(
      (request) => request.body.args.action === "host.update.apply",
    );
    expect(apply?.body.args.input).toEqual({ confirm: true });
    const output = JSON.parse(result.out) as { result: { host: HostMaintenanceSnapshot } };
    expect(output.result.host.version).toBe("2.22.0");
    expect(actions(gateway).filter((action) => action === "run.get")).toHaveLength(3);
  });

  test("a postponed update exits non-zero with the reason", async () => {
    const { box } = await fixture(
      receipt({
        state: "failed",
        stage: "postponed",
        error: { code: "operation-failed", message: "Postponed by someone at the host" },
      }),
    );
    const result = await box.run(["host", "update", "apply", "--yes", "--wait"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Postponed by someone at the host");
  });
});

describe("orkestrator host status", () => {
  test("prints the version and the newest release", async () => {
    const { box } = await fixture(receipt({}));
    const result = await box.run(["host", "status"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Version: 2.22.0");
    expect(result.out).toContain("Latest: 2.22.0 (up to date");
  });

  test("separates container terminals from the host's when the backend reports them", async () => {
    const box = await createSandbox();
    const impact = {
      workingAgents: 1,
      waitingAgents: 0,
      activePipelines: 0,
      terminals: 3,
      hostServers: 0,
      measuredAt: "2026-10-26T12:00:00.000Z",
    };
    let containerTerminals: number | undefined = 2;
    const gateway = await startFakeGateway((request) =>
      String(request.body.args.action) === "host.status"
        ? envelope(
            publicSuccessEnvelope("host.status", {
              ...host("2.22.0"),
              impact: containerTerminals === undefined ? impact : { ...impact, containerTerminals },
            }),
          )
        : defaultResponder()(request),
    );
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    expect((await box.run(["host", "status"])).out).toContain(
      "1 agents working, 0 waiting, 0 pipelines, 3 terminals (2 in containers)",
    );
    // An older backend does not split them.
    containerTerminals = undefined;
    const older = (await box.run(["host", "status"])).out;
    expect(older).toContain("0 pipelines, 3 terminals");
    expect(older).not.toContain("in containers");
  });

  test("an unavailable updater is a structured refusal", async () => {
    const box = await createSandbox();
    const gateway = await startFakeGateway((request) =>
      String(request.body.args.action) === "host.update.check"
        ? envelope(
            publicErrorEnvelope("host.update.check", {
              code: "capability-unavailable",
              message: "This backend is not run by an Orkestrator app that can update itself.",
            }),
          )
        : defaultResponder()(request),
    );
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    const result = await box.run(["host", "update", "check"]);
    expect(result.code).toBe(8);
    expect(result.err).toContain("can update itself");
  });
});

describe("orkestrator host maintenance commands", () => {
  test("--when-idle and --max-wait reach the apply action", async () => {
    const { box, gateway } = await fixture(receipt({ state: "succeeded", stage: "completed" }));
    const result = await box.run([
      "host",
      "update",
      "apply",
      "--yes",
      "--when-idle",
      "--max-wait",
      "30m",
      "--release",
      "2.22.0",
    ]);
    expect(result.code).toBe(0);
    const apply = gateway.requests.find(
      (request) => request.body.args.action === "host.update.apply",
    );
    expect(apply?.body.args.input).toEqual({
      confirm: true,
      version: "2.22.0",
      drain: "when-idle",
      maxWaitSeconds: 1800,
    });
  });

  test("--max-wait without --when-idle is refused before sending", async () => {
    const { box, gateway } = await fixture(receipt({}));
    const result = await box.run(["host", "update", "apply", "--yes", "--max-wait", "30m"]);
    expect(result.code).toBe(2);
    expect(actions(gateway)).not.toContain("host.update.apply");
  });

  test("update cancel sends host.update.cancel", async () => {
    const { box, gateway } = await fixture(receipt({}));
    const result = await box.run(["host", "update", "cancel"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Cancelled update hostupd-1");
    expect(actions(gateway)).toContain("host.update.cancel");
  });

  test("toolchain repair --wait follows the task to the end", async () => {
    const { box, gateway } = await fixture(
      receipt({ action: "host.toolchain.repair", state: "succeeded", stage: "completed" }),
    );
    const result = await box.run(["host", "toolchain", "repair", "--wait"]);
    expect(result.code).toBe(0);
    expect(actions(gateway)).toContain("host.toolchain.repair");
    expect(actions(gateway)).toContain("host.status");
  });

  test("gh latest asks for the latest channel", async () => {
    const { box, gateway } = await fixture(receipt({}));
    const result = await box.run(["host", "gh", "latest"]);
    expect(result.code).toBe(0);
    const request = gateway.requests.find((entry) => entry.body.args.action === "host.gh.update");
    expect(request?.body.args.input).toEqual({ channel: "latest" });
  });
});

test.each(["stable", "beta", "unstable"])(
  "host update channel %s uses the public mutation",
  async (channel) => {
    const { box, gateway } = await fixture(receipt({ state: "succeeded" }));
    const result = await box.run([
      "host",
      "update",
      "channel",
      channel,
      "--request-id",
      "channel-change",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Update channel: ${channel}`);
    expect(
      gateway.requests.find((request) => request.body.args.action === "host.update.channel")?.body
        .args.input,
    ).toEqual({ channel });
  },
);

test("host status prints its channel and an invalid channel sends nothing", async () => {
  const { box, gateway } = await fixture(receipt({ state: "succeeded" }));
  expect((await box.run(["host", "status"])).out).toContain("Update channel: stable");
  const result = await box.run(["host", "update", "channel", "canary"]);
  expect(result.code).toBe(2);
  expect(actions(gateway)).not.toContain("host.update.channel");
});
