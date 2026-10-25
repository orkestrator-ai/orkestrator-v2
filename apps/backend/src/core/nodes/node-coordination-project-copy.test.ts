import { afterEach, expect, spyOn, test } from "bun:test";
import { MailWorld } from "../agent-mail-world-test-support.js";
import { NodeCoordination } from "./node-coordination.js";

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

for (const fail of [false, true]) {
  test(`approved create-project maps choices and mails ${fail ? "failure then retry success" : "success"} to its requesting conversation`, async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let failClone = fail;
    let targetExists = false;
    const summaries = async () => ({
      selfId: "bk_cmd",
      nodes: [
        { nodeId: "bk_leaf", available: true, view: { displayName: "Build box" }, projects: [] },
      ],
    });
    const instance = new NodeCoordination({
      storage: world.storage,
      nodes: {
        selfIdentity: async () => "bk_cmd",
        selfProfile: async () => ({ displayName: "Desk" }),
        listControllers: () => [],
        mostRecentControllerId: () => undefined,
        link: () => null,
        getNode: async () => ({ displayName: "Build box" }),
        subscribe: () => () => {},
        listNodes: async () => ({ nodes: [] }),
      } as never,
      portal: {
        summaries,
        readModel: { onNodeEvent: () => () => {} },
        invokeOnNode: async (input: { command: string; args: Record<string, unknown> }) => {
          calls.push(input);
          let result: unknown = {};
          if (input.command === "get_projects")
            result = targetExists
              ? [
                  {
                    id: "target",
                    localPath: "/chosen/site",
                    gitUrl: "https://github.com/acme/site.git",
                  },
                ]
              : [];
          if (input.command === "start_project_clone") {
            result = failClone
              ? { state: "failed", error: "Disk full" }
              : { state: "completed", projectId: "target" };
            if (!failClone) targetExists = true;
          }
          return { outcome: "ok", result };
        },
      } as never,
      invoke: async <T>(command: string, args = {}) => {
        calls.push({ command, args });
        if (command === "get_project")
          return {
            id: world.projectId,
            name: "site",
            gitUrl: "https://github.com/acme/site.git",
          } as T;
        if (command === "list_project_copy_files")
          return {
            files: [{ path: "config/local.json", bytes: 2 }],
            totalBytes: 2,
            skipped: 0,
            tooLarge: [],
          } as T;
        return {} as T;
      },
      emit: () => {},
    });
    const transfer = spyOn(instance.projectFiles.transfer, "transfer").mockImplementation(
      async (input) => {
        input.onFile?.({ path: "config/local.json", bytes: 2 } as never);
        return { status: "completed" } as never;
      },
    );
    try {
      const request = await instance.actions.create({
        kind: "create-project",
        targets: [
          { nodeId: "bk_leaf", nodeName: "Build box", location: "/suggested", files: [".env"] },
        ],
        requestedBy: {
          projectId: world.projectId,
          coordinatorEnvironmentId: main.environmentId,
          coordinatorTabId: main.tabId,
        },
      });
      const resolved = await instance.actions.resolve(request.requestId, "approve", {
        location: "/chosen/site",
        paths: ["config/local.json"],
        rememberFiles: !fail,
      });
      expect(resolved).toMatchObject({ state: "executed", result: { code: "copying" } });
      const [record] = instance.copies.list();
      expect(record).toMatchObject({
        requestKey: `node-action:${request.requestId}:bk_leaf`,
        actionRequestId: request.requestId,
        paths: ["config/local.json"],
        rememberFiles: !fail,
        source: { nodeId: "bk_cmd", projectId: world.projectId },
        target: { nodeId: "bk_leaf", location: "/chosen/site" },
      });
      await instance.copies.settled(record!.copyId);
      const waitForNotice = async (text: string) => {
        for (let i = 0; i < 100; i++) {
          const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
          const messages = await Promise.all(
            inbox.messages.map((message) =>
              world.storage.getAgentMailMessage(main.environmentId, main.tabId, message.id),
            ),
          );
          if (messages.some((message) => message.body.includes(text))) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`Missing notice: ${text}`);
      };
      await waitForNotice(fail ? "Disk full" : "Copied site to Build box");
      expect(calls.find((call) => call.command === "start_project_clone")?.args).toMatchObject({
        localPath: "/chosen/site",
        requestKey: expect.stringMatching(/^copy:/),
      });
      if (fail) {
        expect(instance.copies.get(record!.copyId)?.stage).toBe("failed");
        failClone = false;
        await instance.copies.start({
          ...record!,
          target: { nodeId: "bk_leaf", location: "/chosen/site" },
        });
        await instance.copies.settled(record!.copyId);
        await waitForNotice("Copied site to Build box");
      }
      expect(calls.find((call) => call.command === "list_project_copy_files")?.args).toEqual({
        projectId: world.projectId,
        paths: ["config/local.json"],
      });
      expect(calls.find((call) => call.command === "update_repository_config")?.args).toMatchObject(
        { projectId: "target", repoConfig: { filesToCopy: fail ? [] : ["config/local.json"] } },
      );
      expect(instance.copies.get(record!.copyId)?.stage).toBe("completed");
    } finally {
      transfer.mockRestore();
      instance.collector.dispose();
    }
  });
}
