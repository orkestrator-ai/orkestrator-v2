/**
 * files across versions (plan item 7002): a current renderer's `files`
 * client against each node of the pair, in a worker's worktree. The tree
 * read with and without a digest, a text read, a save with the editor's
 * precondition, a save whose precondition no longer holds (refused, file
 * unchanged), and a folder created and the file renamed into it. A node
 * with the domain gets version 1 with `expected` marked critical; a
 * pre-contract node gets today's body through version 0.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { filesClient } from "@orkestrator/protocol/contract/domains/files";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const base64 = (text: string) => Buffer.from(text).toString("base64");
/** `Array.isArray` that narrows the tree result's readonly list away. */
const isTreeList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

export default defineScenario({
  domain: "files",
  title: "Tree, read, conditional save and rename in a worker's worktree, from a current renderer",
  requires: {
    command: ["get_local_file_tree", "read_local_file", "write_local_file", "create_local_folder"],
    leaf: ["get_local_file_tree", "read_local_file", "write_local_file", "create_local_folder"],
  },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, filesClient);
      const files = client.api();
      ctx.check(
        `FI-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "files"),
        `picked ${version}`,
      );

      const tree = await files.get_local_file_tree({ worktreePath: worker.worktree });
      const conditional = await files.get_local_file_tree({
        worktreePath: worker.worktree,
        knownDigest: "",
      });
      ctx.check(
        `FI-${tag}2`,
        "the tree reads bare without a digest and conditionally with one",
        Array.isArray(tree) &&
          !isTreeList(conditional) &&
          typeof conditional.digest === "string" &&
          conditional.unchanged === false,
      );

      const file = `qualification-${tag.toLowerCase()}.txt`;
      const first = "first\n";
      await files.write_local_file({
        worktreePath: worker.worktree,
        filePath: file,
        base64Data: base64(first),
      });
      const read = await files.read_local_file({ worktreePath: worker.worktree, filePath: file });
      const second = "second\n";
      await files.write_local_file({
        worktreePath: worker.worktree,
        filePath: file,
        base64Data: base64(second),
        expected: { sha256: sha256(first) },
      });
      const onDisk = path.join(worker.worktree, file);
      ctx.check(
        `FI-${tag}3`,
        "a save whose precondition holds replaces the file the editor loaded",
        read.content === first && (await readFile(onDisk, "utf8")) === second,
      );
      const refused = await files
        .write_local_file({
          worktreePath: worker.worktree,
          filePath: file,
          base64Data: base64("third\n"),
          expected: { sha256: sha256(first) },
        })
        .then(
          () => "",
          (error: unknown) => String(error),
        );
      ctx.check(
        `FI-${tag}4`,
        "a save whose precondition no longer holds is refused and leaves the file alone",
        refused !== "" && (await readFile(onDisk, "utf8")) === second,
        refused.slice(0, 120),
      );

      const folder = await files.create_local_folder({
        environmentId: worker.environmentId,
        parentDirectory: ".",
        folderName: `moved-${tag.toLowerCase()}`,
      });
      const moved = await files.move_local_file({
        environmentId: worker.environmentId,
        sourcePath: file,
        destinationDirectory: folder,
      });
      ctx.check(
        `FI-${tag}5`,
        "a created folder receives the moved file",
        (await readFile(path.join(worker.worktree, moved), "utf8")) === second,
        moved,
      );
      ctx.note(`${node.role} files`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
