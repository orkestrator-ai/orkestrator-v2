/**
 * Opt in with RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE
 * set to a locally available Orkestrator image. The disposable workspace
 * uses the image's real Node and never mounts a host directory.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MAX_WORKSPACE_FILE_NAME_BYTES } from "@orkestrator/protocol/contract/domains/files";
import { createContainerFile } from "../src/core/commands/file-create";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && !!image;

test.skipIf(!enabled)(
  "Docker stdin EOF publishes one empty file at the 213-byte boundary",
  async () => {
    const name = "é".repeat(Math.floor(MAX_WORKSPACE_FILE_NAME_BYTES / 2)) + "x";
    const timeoutMs = 30_000;
    const docker = async (args: string[]) =>
      (await runCommand("docker", args, { timeoutMs })).stdout;
    const containerId = (
      await docker([
        "run",
        "--detach",
        "--pull=never",
        "--network=none",
        "--name",
        `ork-file-create-test-${randomUUID()}`,
        "--entrypoint",
        "node",
        image!,
        "-e",
        "setInterval(() => {}, 1000)",
      ])
    ).trim();

    try {
      await docker(["exec", containerId, "mkdir", "/workspace/file-create-test"]);
      expect(Buffer.byteLength(name)).toBe(MAX_WORKSPACE_FILE_NAME_BYTES);
      await expect(
        createContainerFile(runCommand, containerId, "file-create-test/", name, timeoutMs),
      ).resolves.toBe(`file-create-test/${name}`);
      await expect(
        createContainerFile(runCommand, containerId, "file-create-test", name, timeoutMs),
      ).rejects.toThrow(`A file or folder already exists at file-create-test/${name}`);
      const result = await docker([
        "exec",
        containerId,
        "node",
        "-e",
        `const fs = require("node:fs");
         const dir = "/workspace/file-create-test";
         const entries = fs.readdirSync(dir);
         console.log(JSON.stringify({ entries, bytes: fs.statSync(dir + "/" + process.argv[1]).size }));`,
        name,
      ]);
      expect(JSON.parse(result)).toEqual({ entries: [name], bytes: 0 });
    } finally {
      await docker(["rm", "--force", containerId]);
    }
  },
  120_000,
);
