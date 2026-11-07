import { expect, test } from "bun:test";
import { toWire, unknownCommand, fromWire } from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { NodeFileTransfer } from "./node-file-transfer.js";
import { NodeProjectCopies } from "./node-project-copy.js";

/** A source machine whose candidate listing fails with `failure`. */
function copies(failure: unknown) {
  return new NodeProjectCopies({
    selfId: async () => "bk_self",
    selfName: async () => "This machine",
    summaries: async () => ({ selfId: "bk_self" as never, nodes: [] }),
    invokerFor: () =>
      (async (command: string) => {
        if (command === "get_project") return { id: "p1", name: "site", gitUrl: null };
        throw failure;
      }) as never,
    transfer: {} as NodeFileTransfer,
    emit: () => {},
  });
}

const UPDATE = "Update Orkestrator on that machine to copy its projects.";

test("an older source machine (coded, through a node link) asks for an update", async () => {
  const rebuilt = fromWire(
    JSON.parse(JSON.stringify(toWire(unknownCommand("list_project_copy_candidates")))),
  );
  await expect(copies(rebuilt).copyOptions({ nodeId: "bk_a", projectId: "p1" })).rejects.toThrow(
    UPDATE,
  );
});

test("a pre-contract source machine's legacy text also asks for an update", async () => {
  const legacy = new Error(unknownBackendCommandMessage("list_project_copy_candidates"));
  await expect(copies(legacy).copyOptions({ nodeId: "bk_a", projectId: "p1" })).rejects.toThrow(
    UPDATE,
  );
});

test("another failure that names the command is not an update", async () => {
  for (const failure of [
    new Error("list_project_copy_candidates: project not found"),
    unknownCommand("get_inner_command"),
  ]) {
    await expect(copies(failure).copyOptions({ nodeId: "bk_a", projectId: "p1" })).rejects.toThrow(
      failure.message,
    );
  }
});
