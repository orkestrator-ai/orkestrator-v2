import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { useEnvironmentListSync } from "./useEnvironmentListSync";

const LEAF = "bk_leaf-list-sync" as BackendId;

function Probe({
  refreshProject,
  refreshEnvironment,
}: {
  refreshProject: (projectId: string) => Promise<void>;
  refreshEnvironment: (projectId: string, environmentId: string) => Promise<boolean>;
}) {
  useEnvironmentListSync(["project-1"], refreshProject, refreshEnvironment);
  return null;
}

describe("useEnvironmentListSync", () => {
  afterEach(() => {
    cleanup();
    cleanupNodeScopes();
  });

  test("a leaf's host hears the leaf's environment changes, not the command node's", async () => {
    const windowScope = new WindowScope();
    const command = windowScope.open({ role: "command", client: new FakeNodeClient() });
    const refreshProject = mock(async (_projectId: string) => undefined);
    const refreshEnvironment = mock(async (_projectId: string, _environmentId: string) => true);
    const { scope: leaf } = renderInNodeScope(
      <Probe refreshProject={refreshProject} refreshEnvironment={refreshEnvironment} />,
      { role: "leaf", client: new FakeNodeClient({ nodeId: LEAF }), windowScope },
    );

    // The command node's change is dispatched first, so its coalesced
    // delivery runs before the leaf's: once the leaf's refresh is seen, the
    // command node's has had its turn.
    dispatchResourceChange(
      { resource: "environment", id: "env-on-command", projectId: "project-1", revision: 1 },
      command,
    );
    dispatchResourceChange(
      { resource: "environment", id: "env-on-leaf", projectId: "project-1", revision: 1 },
      leaf,
    );
    await waitFor(() => expect(refreshEnvironment).toHaveBeenCalled());
    expect(refreshEnvironment.mock.calls).toEqual([["project-1", "env-on-leaf"]]);
    expect(refreshProject).not.toHaveBeenCalled();
  });
});
