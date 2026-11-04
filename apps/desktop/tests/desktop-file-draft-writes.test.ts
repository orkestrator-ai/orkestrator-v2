import { expect, test } from "bun:test";
import { DesktopFileDraftWrites } from "../electron/desktop-file-draft-writes";

test("main retains large queued revisions through renderer teardown", async () => {
  const queue = new DesktopFileDraftWrites();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revisions: unknown[] = [];
  let content = "";
  const backend = {
    async invoke(_command: string, args: Record<string, unknown>) {
      revisions.push(args.expectedRevision);
      if (revisions.length === 1) await held;
      content = String(args.content);
      return { revision: revisions.length };
    },
  };
  const args = {
    command: "save_file_draft",
    clientId: "client",
    draftKey: "file",
    expectedRevision: 0,
  };
  const first = queue.write(1, { ...args, content: "old" }, backend);
  const latest = "latest".repeat(20_000);
  const second = queue.write(1, { ...args, content: latest }, backend);
  queue.releaseSender(1);
  release();
  await Promise.all([first, second]);
  expect(revisions).toEqual([0, 1]);
  expect(content).toBe(latest);
});

test("conflict fences successors instead of overwriting another writer", async () => {
  const queue = new DesktopFileDraftWrites();
  let calls = 0;
  const backend = {
    invoke() {
      calls += 1;
      throw new Error("draft conflict");
    },
  };
  const args = {
    command: "save_file_draft",
    clientId: "client",
    draftKey: "file",
    expectedRevision: 0,
  };
  await Promise.all([
    expect(queue.write(1, args, backend)).rejects.toThrow("draft conflict"),
    expect(queue.write(1, args, backend)).rejects.toThrow("draft conflict"),
  ]);
  expect(calls).toBe(1);
});

test("retains CAS cursor while the renderer still holds an older IPC response", async () => {
  const queue = new DesktopFileDraftWrites();
  const revisions: unknown[] = [];
  const backend = {
    invoke(_command: string, args: Record<string, unknown>) {
      revisions.push(args.expectedRevision);
      return { revision: revisions.length };
    },
  };
  const args = {
    command: "save_file_draft",
    clientId: "client",
    draftKey: "file",
    expectedRevision: 0,
  };
  await queue.write(1, args, backend);
  await queue.write(1, args, backend);
  expect(revisions).toEqual([0, 1]);
  queue.releaseSender(1);
});
