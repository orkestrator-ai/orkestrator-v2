import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  useLoopedReviewStore,
  type LoopedReviewPhase,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import type { Environment } from "@/types";

/**
 * The supervisor is the only thing that keeps a looped review advancing while no
 * tab is visible, and everything it does is gated on a controller lease. These
 * tests therefore assert the lease lifecycle — grant, refusal, malformed grant,
 * expiry, release — rather than any workflow progress, which
 * `LoopedReviewTab.test.tsx` already owns.
 *
 * `LoopedReviewTab` is stubbed because it is the unit under test's collaborator,
 * not its subject: driving the real tab would connect agents and mutate the
 * workflow. The real module is snapshotted first and restored in `afterAll` so
 * later suites in a non-isolated run still import the real component.
 */
import * as realLoopedReviewTab from "./LoopedReviewTab";

const realLoopedReviewTabSnapshot = { ...realLoopedReviewTab };

interface StubProps {
  data: { workflowId: string; environmentId: string; isLocal: boolean };
  controllerLease: { ownerId: string; token: string; expiresAt: string };
  driveWorkflow?: boolean;
  controllerOnly?: boolean;
}

/**
 * Counts every mount, including one that is immediately withdrawn again. A
 * controller that renders even for a single tick has already been handed the
 * lease it needs to dispatch a turn, so "never mounted" is the real contract for
 * a refused claim.
 */
let controllerMounts = 0;

mock.module("./LoopedReviewTab", () => ({
  ...realLoopedReviewTabSnapshot,
  LoopedReviewTab: ({ data, controllerLease, driveWorkflow, controllerOnly }: StubProps) => {
    controllerMounts += 1;
    return (
      <div
        data-testid="controller"
        data-workflow={data.workflowId}
        data-environment={data.environmentId}
        data-local={String(data.isLocal)}
        data-owner={controllerLease.ownerId}
        data-token={controllerLease.token}
        data-drive={String(driveWorkflow)}
        data-controller-only={String(controllerOnly)}
      />
    );
  },
}));

afterAll(() => {
  mock.module("./LoopedReviewTab", () => realLoopedReviewTabSnapshot);
});

const { LoopedReviewSupervisor } = await import("./LoopedReviewSupervisor");

function environment(
  id: string,
  environmentType: Environment["environmentType"] = "local",
): Environment {
  return {
    id,
    projectId: "project-1",
    name: `Environment ${id}`,
    branch: "feature",
    containerId: environmentType === "local" ? null : `container-${id}`,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType,
    worktreePath: "/tmp/review-worktree",
    setupScriptsComplete: true,
  } as Environment;
}

function seedWorkflow(
  id: string,
  phase: LoopedReviewPhase,
  environmentId = "env-review",
): LoopedReviewWorkflow {
  const createdId = useLoopedReviewStore.getState().createWorkflow({
    environmentId,
    projectId: "project-1",
    agent: "codex",
    model: "codex-model",
    targetBranch: "main",
    allowance: 6,
  });
  const created = useLoopedReviewStore.getState().workflows.get(createdId)!;
  const workflow = { ...created, id, environmentId, phase };
  useLoopedReviewStore.setState((state) => {
    const workflows = new Map(state.workflows);
    workflows.delete(createdId);
    workflows.set(id, workflow);
    return { workflows };
  });
  return workflow;
}

function granted(token: string, leaseMs = 15_000) {
  return {
    granted: true as const,
    token,
    expiresAt: new Date(Date.now() + leaseMs).toISOString(),
  };
}

const tick = (ms: number) => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
});

function controllers(): HTMLElement[] {
  return screen.queryAllByTestId("controller");
}

beforeEach(() => {
  controllerMounts = 0;
  useLoopedReviewStore.setState({ workflows: new Map() });
  useEnvironmentStore.setState({ environments: [environment("env-review")] });
});

afterEach(() => {
  cleanup();
  useLoopedReviewStore.setState({ workflows: new Map() });
  useEnvironmentStore.setState({ environments: [] });
});

describe("LoopedReviewSupervisor lease acquisition", () => {
  test("drives a granted workflow as a headless controller", async () => {
    seedWorkflow("workflow-1", "reconciling");

    render(
      <LoopedReviewSupervisor
        claimController={async () => granted("lease-token")}
        validateController={async () => true}
        releaseController={async () => undefined}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(1));
    const controller = controllers()[0]!;
    expect(controller.dataset.workflow).toBe("workflow-1");
    expect(controller.dataset.token).toBe("lease-token");
    // The supervisor's tab exists only to execute; it is never the visible one.
    expect(controller.dataset.drive).toBe("true");
    expect(controller.dataset.controllerOnly).toBe("true");
  });

  test("renders no controller and releases nothing when the claim request fails", async () => {
    seedWorkflow("workflow-1", "reconciling");
    const claimController = mock(async () => {
      throw new Error("Controller lease backend is unavailable");
    });
    const releaseController = mock(async () => undefined);

    render(
      <LoopedReviewSupervisor
        claimController={claimController}
        validateController={async () => true}
        releaseController={releaseController}
        controllerRenewMs={10_000}
      />,
    );

    await waitFor(() => expect(claimController).toHaveBeenCalled());
    await tick(10);

    expect(controllerMounts).toBe(0);
    // Releasing a lease this client never held would evict whichever client
    // does hold it.
    expect(releaseController).not.toHaveBeenCalled();
  });

  test("keeps retrying after a failed claim and mounts once one succeeds", async () => {
    seedWorkflow("workflow-1", "reconciling");
    let attempts = 0;

    render(
      <LoopedReviewSupervisor
        claimController={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Controller lease backend is unavailable");
          return granted("lease-token");
        }}
        validateController={async () => true}
        releaseController={async () => undefined}
        controllerRenewMs={5}
      />,
    );

    // A transient outage must not permanently strand a workflow with no driver.
    await waitFor(() => expect(controllers()).toHaveLength(1));
    expect(attempts).toBeGreaterThan(1);
  });

  test.each([
    {
      refusal: "the claim was denied",
      result: {
        granted: false,
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
      },
    },
    {
      refusal: "the grant carries no token",
      result: {
        granted: true,
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
      },
    },
    {
      refusal: "the expiry is unparseable",
      result: { granted: true, token: "lease-token", expiresAt: "not-a-timestamp" },
    },
    {
      refusal: "the lease has already expired",
      result: {
        granted: true,
        token: "lease-token",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    },
  ])("does not drive the workflow when $refusal", async ({ result }) => {
    seedWorkflow("workflow-1", "reconciling");
    const claimController = mock(async () => result as never);

    render(
      <LoopedReviewSupervisor
        claimController={claimController}
        validateController={async () => true}
        releaseController={async () => undefined}
        controllerRenewMs={10_000}
      />,
    );

    await waitFor(() => expect(claimController).toHaveBeenCalled());
    await tick(10);

    // Anything short of a token with a live, parseable expiry is not ownership,
    // and driving without ownership is how two clients dispatch the same phase.
    expect(controllers()).toHaveLength(0);
    expect(controllerMounts).toBe(0);
  });

  test("stops driving once its own lease reaches its expiry", async () => {
    seedWorkflow("workflow-1", "reconciling");

    render(
      <LoopedReviewSupervisor
        claimController={async () => granted("lease-token", 25)}
        validateController={async () => true}
        releaseController={async () => undefined}
        // Renewal is slower than the lease, so the local expiry timer is the only
        // thing that can withdraw the controller.
        controllerRenewMs={10_000}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(1));
    await tick(60);

    expect(controllers()).toHaveLength(0);
  });
});

describe("LoopedReviewSupervisor lease release", () => {
  test("releases its lease when the supervisor unmounts", async () => {
    seedWorkflow("workflow-1", "reconciling");
    const claimController = mock(async () => granted("lease-token"));
    const released: Array<[string, string, string]> = [];
    const releaseController = mock(async (
      workflowId: string,
      ownerId: string,
      token: string,
    ) => {
      released.push([workflowId, ownerId, token]);
    });

    const { unmount } = render(
      <LoopedReviewSupervisor
        claimController={claimController}
        validateController={async () => true}
        releaseController={releaseController}
        controllerRenewMs={5}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(1));
    const ownerId = controllers()[0]!.dataset.owner!;
    const claimsBeforeUnmount = claimController.mock.calls.length;

    unmount();
    await waitFor(() => expect(released).toHaveLength(1));

    // Handing the lease back is what lets another client pick the workflow up
    // immediately instead of waiting out the full lease.
    expect(released[0]).toEqual(["workflow-1", ownerId, "lease-token"]);
    await tick(30);
    expect(claimController.mock.calls.length).toBe(claimsBeforeUnmount);
  });

  test("releases the lease when its workflow reaches a terminal phase", async () => {
    const workflow = seedWorkflow("workflow-1", "creating-pr");
    const releaseController = mock(async () => undefined);

    render(
      <LoopedReviewSupervisor
        claimController={async () => granted("lease-token")}
        validateController={async () => true}
        releaseController={releaseController}
        controllerRenewMs={10_000}
      />,
    );
    await waitFor(() => expect(controllers()).toHaveLength(1));

    act(() => {
      useLoopedReviewStore.setState({
        workflows: new Map([[workflow.id, { ...workflow, phase: "cancelled" }]]),
      });
    });

    await waitFor(() => expect(controllers()).toHaveLength(0));
    expect(releaseController).toHaveBeenCalledWith(
      "workflow-1",
      expect.any(String),
      "lease-token",
    );
  });
});

describe("LoopedReviewSupervisor workflow selection", () => {
  test("claims a lease only for workflows that are still running", async () => {
    seedWorkflow("workflow-done", "completed");
    seedWorkflow("workflow-cancelled", "cancelled");
    // Paused and failed workflows are not terminal: they can still be resumed or
    // retried, so they keep a controller.
    seedWorkflow("workflow-paused", "paused");
    seedWorkflow("workflow-live", "reconciling");
    const claimed: string[] = [];

    render(
      <LoopedReviewSupervisor
        claimController={async (workflowId) => {
          claimed.push(workflowId);
          return granted(`token-${workflowId}`);
        }}
        validateController={async () => true}
        releaseController={async () => undefined}
        controllerRenewMs={10_000}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(2));
    expect(claimed.sort()).toEqual(["workflow-live", "workflow-paused"]);
  });

  test("does not claim a lease for a workflow whose environment is unknown", async () => {
    seedWorkflow("workflow-orphan", "reconciling", "env-missing");
    const claimController = mock(async () => granted("lease-token"));

    render(
      <LoopedReviewSupervisor
        claimController={claimController}
        validateController={async () => true}
        releaseController={async () => undefined}
        controllerRenewMs={10_000}
      />,
    );
    await tick(20);

    // Without an environment there is nowhere to connect an agent, so taking the
    // lease would only block whichever client can still see the environment.
    expect(claimController).not.toHaveBeenCalled();
    expect(controllers()).toHaveLength(0);
  });

  test("marks a containerized review as non-local for its controller", async () => {
    useEnvironmentStore.setState({
      environments: [environment("env-review", "containerized")],
    });
    seedWorkflow("workflow-1", "reconciling");

    render(
      <LoopedReviewSupervisor
        claimController={async () => granted("lease-token")}
        validateController={async () => true}
        releaseController={async () => undefined}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(1));
    expect(controllers()[0]!.dataset.local).toBe("false");
  });

  test("drives concurrent workflows under independent leases", async () => {
    useEnvironmentStore.setState({
      environments: [environment("env-review"), environment("env-other")],
    });
    seedWorkflow("workflow-1", "reconciling");
    seedWorkflow("workflow-2", "fixing", "env-other");
    const released: Array<[string, string, string]> = [];

    const { unmount } = render(
      <LoopedReviewSupervisor
        claimController={async (workflowId) => granted(`token-${workflowId}`)}
        validateController={async () => true}
        releaseController={async (
          workflowId: string,
          ownerId: string,
          token: string,
        ) => {
          released.push([workflowId, ownerId, token]);
        }}
        controllerRenewMs={10_000}
      />,
    );

    await waitFor(() => expect(controllers()).toHaveLength(2));
    const byWorkflow = new Map(
      controllers().map((node) => [node.dataset.workflow!, node.dataset]),
    );
    expect(byWorkflow.get("workflow-1")?.token).toBe("token-workflow-1");
    expect(byWorkflow.get("workflow-2")?.token).toBe("token-workflow-2");
    expect(byWorkflow.get("workflow-2")?.environment).toBe("env-other");
    // A shared controller id would let one workflow's release revoke the other's
    // lease, since the backend fences on owner identity.
    expect(byWorkflow.get("workflow-1")?.owner)
      .not.toBe(byWorkflow.get("workflow-2")?.owner);

    unmount();
    await waitFor(() => expect(released).toHaveLength(2));
    expect(released.map(([workflowId]) => workflowId).sort())
      .toEqual(["workflow-1", "workflow-2"]);
  });
});
