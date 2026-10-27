import { expect, spyOn, test } from "bun:test";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { OrkestratorBackend } from "./index.js";
import type { NodeActionRequest } from "./nodes/node-action-requests.js";
import type { StorageService } from "./storage.js";

test("backend init resumes persisted AGENTS.md approval once and mails the result", async () => {
  const world = await MailWorld.create();
  const main = await world.main();
  let runs = 0;
  let notices = 0;
  try {
    for (let boot = 0; boot < 2; boot++) {
      const backend = new OrkestratorBackend({
        dataDir: world.storage.getDataDir(),
        toolchainBinDir: "",
        appRoot: "",
        resourceRoot: "",
        emit: () => undefined,
        transcriptArtifactRuntime: false,
        agentTools: {
          start: async () => undefined,
          stop: async () => undefined,
          connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
          revokeEnvironment: () => undefined,
        },
        startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
      });
      const storage = (backend as unknown as { context: { storage: StorageService } }).context
        .storage;
      if (boot === 0) {
        const request: NodeActionRequest = {
          requestId: "restart-approval",
          kind: "update-agents-md",
          state: "approved",
          targets: [
            {
              nodeId: await backend.nodes.selfIdentity(),
              nodeName: "this machine",
              projectId: world.projectId,
            },
          ],
          requestedBy: {
            coordinatorEnvironmentId: main.environmentId,
            coordinatorTabId: main.tabId,
            projectId: world.projectId,
          },
          createdAt: new Date().toISOString(),
          expiresAt: new Date(0).toISOString(),
          agentsMd: { changes: [{ action: "add", text: "Original." }] },
          approval: { changes: [{ action: "add", text: "Edited." }] },
        };
        await world.storage.nodes.saveNodeActionRequests([request]);
      }
      const invoke = backend.invoke.bind(backend);
      const intercepted = spyOn(backend, "invoke").mockImplementation(
        async <T>(command: string, args: Record<string, unknown> = {}) => {
          if (command !== "open_project_agents_md_pr") return invoke<T>(command, args);
          runs++;
          expect(args.changes).toEqual([{ action: "add", text: "Edited." }]);
          return {
            status: "existing",
            url: "https://github.com/acme/widgets/pull/9",
            baseBranch: "main",
            branch: "branch",
            outcomes: [],
          } as T;
        },
      );
      const notify = spyOn(storage, "sendAgentMail");
      try {
        await backend.init();
        for (
          let attempt = 0;
          attempt < 100 &&
          (await backend.nodeCoordination.actions.get("restart-approval"))?.state !== "executed";
          attempt++
        )
          await Bun.sleep(10);
        expect(await backend.nodeCoordination.actions.get("restart-approval")).toMatchObject({
          state: "executed",
          result: { url: "https://github.com/acme/widgets/pull/9" },
        });
        // Persistence precedes notification; let the notification drain finish.
        for (
          let attempt = 0;
          boot === 0 && attempt < 100 && notify.mock.calls.length === 0;
          attempt++
        )
          await Bun.sleep(10);
        notices += notify.mock.calls.length;
        if (boot === 0) {
          expect(notify.mock.calls[0]![1]).toMatchObject({
            toEnvironmentId: main.environmentId,
            toTabId: main.tabId,
          });
          expect(notify.mock.calls[0]![1].body).toContain("https://github.com/acme/widgets/pull/9");
        }
      } finally {
        intercepted.mockRestore();
        notify.mockRestore();
        await backend.shutdown();
      }
    }
    expect(runs).toBe(1);
    expect(notices).toBe(1);
  } finally {
    await world.close();
  }
}, 60_000);
