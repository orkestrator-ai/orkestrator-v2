/**
 * `transcript_media_pin` reads a file only through the registered readers,
 * refuses another environment's container, and answers with the first bytes
 * a message showed after the file is overwritten.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRANSCRIPT_MEDIA_PIN_COMMAND } from "@orkestrator/protocol/transcript-media-pins";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerTranscriptMediaCommands } from "./commands-registry-transcript-media.js";

let dataDir: string;
let workspace: string;
const commands = new Map<string, CommandHandler>();
const readerCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let containerBytes = "container round 1";

registerTranscriptMediaCommands(
  (name, handler) => commands.set(name, handler),
  (name) => commands.get(name),
);
commands.set("read_file_base64", async (args) => {
  readerCalls.push({ name: "read_file_base64", args: args as Record<string, unknown> });
  const { readFile } = await import("node:fs/promises");
  return (await readFile(String(args.filePath))).toString("base64");
});
commands.set("read_container_file_base64", async (args) => {
  readerCalls.push({ name: "read_container_file_base64", args: args as Record<string, unknown> });
  return `${Buffer.from(containerBytes).toString("base64")}\n`;
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-media-pin-data-"));
  workspace = await mkdtemp(path.join(os.tmpdir(), "orkestrator-media-pin-workspace-"));
  readerCalls.length = 0;
  containerBytes = "container round 1";
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function invoke(args: Record<string, unknown>, containerId: string | null = null): Promise<any> {
  const context = {
    storage: {
      getDataDir: () => dataDir,
      getEnvironment: async (id: string) => (id === "env-1" ? { id, containerId } : null),
    },
  } as unknown as CommandContext;
  return Promise.resolve(commands.get(TRANSCRIPT_MEDIA_PIN_COMMAND)!(args as never, context));
}

const decode = (response: { dataBase64: string }) =>
  Buffer.from(response.dataBase64, "base64").toString();
const scope = { environmentId: "env-1", logicalSessionKey: "tab-1" };

describe("transcript_media_pin", () => {
  test("a host image keeps the version its message first showed", async () => {
    const shot = path.join(workspace, "1-top.png");
    await writeFile(shot, "round 1");
    const modified = new Date("2026-10-29T10:00:00.000Z");
    await utimes(shot, modified, modified);

    const first = await invoke({ ...scope, messageId: "m1", path: shot });
    expect(first).toMatchObject({
      status: "pinned",
      byteLength: 7,
      fileModifiedAt: "2026-10-29T10:00:00.000Z",
    });
    expect(decode(first)).toBe("round 1");
    expect(readerCalls).toEqual([{ name: "read_file_base64", args: { filePath: shot } }]);

    await writeFile(shot, "round 2!");
    expect(decode(await invoke({ ...scope, messageId: "m1", path: shot }))).toBe("round 1");
    expect(decode(await invoke({ ...scope, messageId: "m2", path: shot }))).toBe("round 2!");
    // The saved m1 copy answered without a second read.
    expect(readerCalls).toHaveLength(2);
  });

  test("a container image is read through the container reader with a relative path", async () => {
    const first = await invoke(
      { ...scope, messageId: "m1", path: "/workspace/shots/a.png", containerId: "c-1" },
      "c-1",
    );
    expect(decode(first)).toBe("container round 1");
    expect(readerCalls).toEqual([
      {
        name: "read_container_file_base64",
        args: { containerId: "c-1", filePath: "shots/a.png" },
      },
    ]);
    containerBytes = "container round 2";
    // Same reference written relatively: the same pin.
    const again = await invoke(
      { ...scope, messageId: "m1", path: "shots/a.png", containerId: "c-1" },
      "c-1",
    );
    expect(decode(again)).toBe("container round 1");
  });

  test("refuses another environment's container and paths that escape /workspace", async () => {
    await expect(
      invoke({ ...scope, messageId: "m1", path: "a.png", containerId: "c-other" }, "c-1"),
    ).rejects.toThrow("Access denied");
    await expect(
      invoke({ ...scope, messageId: "m1", path: "a.png", containerId: "c-1" }, null),
    ).rejects.toThrow("Access denied");
    await expect(
      invoke({ ...scope, messageId: "m1", path: "../etc/passwd", containerId: "c-1" }, "c-1"),
    ).rejects.toThrow("outside the container workspace");
    expect(readerCalls).toEqual([]);
  });

  test("validates its arguments before reading", async () => {
    await expect(invoke({ ...scope, messageId: "m1", path: "relative.png" })).rejects.toThrow(
      "must be absolute",
    );
    await expect(invoke({ ...scope, path: "/w/a.png" })).rejects.toThrow("messageId is required");
    await expect(
      invoke({ ...scope, messageId: "m1", path: "/w/a.png", extra: true }),
    ).rejects.toThrow("Unknown arguments: extra");
    await expect(
      invoke({ ...scope, environmentId: "env-missing", messageId: "m1", path: "/w/a.png" }),
    ).rejects.toThrow("Environment not found");
    expect(readerCalls).toEqual([]);
  });

  test("reader errors reach the caller unchanged", async () => {
    await expect(
      invoke({ ...scope, messageId: "m1", path: path.join(workspace, "missing.png") }),
    ).rejects.toThrow("ENOENT");
  });
});
