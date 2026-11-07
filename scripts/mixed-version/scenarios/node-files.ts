/**
 * node-files across versions (plan item 1010's pilot): the command node copies
 * a file from its project root into a worker on the leaf, and one from the
 * leaf's project root into its own worker (the leaf's stat/read, then its
 * begin/append/commit write). A second copy without `overwrite` is refused by
 * the destination and leaves the file alone; with `overwrite` it replaces it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { defineScenario } from "../scenario.ts";

type Receipt = {
  status: string;
  bytes: number;
  files?: Array<{ path: string; destination: string; sha256: string }>;
  error?: { code?: string; message?: string };
};

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function fileSha(file: string): Promise<string | null> {
  return existsSync(file) ? sha256(await readFile(file)) : null;
}

export default defineScenario({
  domain: "node-files",
  title: "File transfer both ways between project roots and workers",
  requires: {
    command: ["transfer_node_files", "create_environment"],
    leaf: [
      "stat_node_file",
      "read_node_file",
      "begin_node_file_write",
      "append_node_file_write",
      "commit_node_file_write",
      "abort_node_file_write",
      "create_environment",
    ],
  },
  async run(ctx) {
    const { command, leaf, fixtures } = ctx;
    const here = await fixtures.project(command);
    const there = await fixtures.project(leaf);
    const leafWorker = await fixtures.worker(leaf);
    const ownWorker = await fixtures.worker(command);
    const actor = "mixed-version qualification";

    // Down: this node's project root to the leaf's worker.
    const down = {
      from: { nodeId: command.id, scope: { projectId: here.projectId } },
      to: { nodeId: leaf.id, scope: { environmentId: leafWorker.environmentId } },
      files: [here.ownFile],
      actor,
    };
    const sent = await command.invoke<Receipt>("transfer_node_files", {
      ...down,
      overwrite: false,
    });
    const landed = path.join(leafWorker.worktree, here.ownFile);
    ctx.check(
      "NF-01",
      "a file from the command node's project root lands in the leaf's worker, same bytes",
      sent.status === "completed" && (await fileSha(landed)) === sha256(here.ownContent),
      `${sent.status} ${sent.error?.message ?? ""}`,
    );

    // Up: the leaf's project root to this node's worker.
    const pulled = await command.invoke<Receipt>("transfer_node_files", {
      from: { nodeId: leaf.id, scope: { projectId: there.projectId } },
      to: { nodeId: command.id, scope: { environmentId: ownWorker.environmentId } },
      files: [there.ownFile],
      overwrite: false,
      actor,
    });
    ctx.check(
      "NF-02",
      "a file from the leaf's project root lands in the command node's worker, same bytes",
      pulled.status === "completed" &&
        (await fileSha(path.join(ownWorker.worktree, there.ownFile))) === sha256(there.ownContent),
      `${pulled.status} ${pulled.error?.message ?? ""}`,
    );

    // The destination keeps an existing file unless told to replace it.
    const before = await fileSha(landed);
    const again = await command.invoke<Receipt>("transfer_node_files", {
      ...down,
      overwrite: false,
    });
    ctx.check(
      "NF-03",
      "copying onto an existing file without overwrite fails and leaves it alone",
      again.status === "failed" && (await fileSha(landed)) === before,
      `${again.status} ${again.error?.code ?? ""}`,
    );
    const replaced = await command.invoke<Receipt>("transfer_node_files", {
      ...down,
      overwrite: true,
    });
    ctx.check(
      "NF-04",
      "with overwrite the copy completes, verified by its SHA-256",
      replaced.status === "completed" &&
        replaced.files?.[0]?.sha256 === sha256(here.ownContent) &&
        (await fileSha(landed)) === sha256(here.ownContent),
      `${replaced.status} ${replaced.error?.message ?? ""}`,
    );
    ctx.note("transfers", {
      down: sent.status,
      up: pulled.status,
      refused: again.error?.code,
      replaced: replaced.status,
    });

    const expected = ctx.expectedAdapter("node-files");
    const v0 = await ctx.adapterCallsSince("node-files", 0);
    if (expected !== null && v0 !== null) {
      ctx.check(
        "NF-05",
        expected === 0
          ? "the command node reached the pre-contract leaf through the node-files v0 adapter"
          : "the command node used node-files v1 (no v0 adapter call)",
        expected === 0 ? v0 > 0 : v0 === 0,
        `v0 calls ${v0}`,
      );
    }
  },
});
