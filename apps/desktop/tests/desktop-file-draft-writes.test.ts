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

const draftArgs = {
  command: "save_file_draft",
  clientId: "client",
  draftKey: "file",
  expectedRevision: 0,
};
const savedBackend = { invoke: () => ({ revision: 1 }) };

test("released clients stay bounded across more than 1,024 editor lifetimes", async () => {
  const queue = new DesktopFileDraftWrites();
  for (let i = 0; i < 1100; i++) {
    await queue.write(1, { ...draftArgs, clientId: String(i) }, savedBackend);
    queue.releaseClient(1, String(i));
  }
  await expect(queue.write(1, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
});

test("release drains pending writes, fences new writes, and is sender scoped", async () => {
  const queue = new DesktopFileDraftWrites();
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const backend = {
    invoke: async () => {
      await held;
      return { revision: 1 };
    },
  };
  const pending = queue.write(1, draftArgs, backend);
  queue.releaseClient(1, "client");
  await expect(queue.write(1, draftArgs, backend)).rejects.toThrow("released");
  await expect(queue.write(2, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
  resume();
  await pending;
  await Promise.resolve();
  await expect(queue.write(1, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
});

test("enforces queue capacity and sender cleanup restores admission", async () => {
  const queue = new DesktopFileDraftWrites();
  for (let i = 0; i < 1024; i++)
    await queue.write(1, { ...draftArgs, clientId: String(i) }, savedBackend);
  await expect(queue.write(2, draftArgs, savedBackend)).rejects.toThrow("client capacity");
  queue.releaseSender(1);
  await expect(queue.write(2, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
});

test("enforces in-flight capacity and releases it after settlement", async () => {
  const queue = new DesktopFileDraftWrites();
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const backend = {
    invoke: async () => {
      await held;
      return { revision: 1 };
    },
  };
  const pending = Array.from({ length: 128 }, () => queue.write(1, draftArgs, backend));
  await expect(queue.write(1, draftArgs, backend)).rejects.toThrow("write capacity");
  resume();
  await Promise.all(pending);
  await expect(queue.write(1, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
});

test("rejects oversized writes and invalid commands before invoking backend", async () => {
  const queue = new DesktopFileDraftWrites();
  let calls = 0;
  const backend = {
    invoke: () => {
      calls++;
      return { revision: 1 };
    },
  };
  await expect(
    queue.write(1, { ...draftArgs, content: "x".repeat(64 * 1024 * 1024) }, backend),
  ).rejects.toThrow("write capacity");
  await expect(queue.write(1, { ...draftArgs, command: "arbitrary" }, backend)).rejects.toThrow(
    "Invalid",
  );
  expect(calls).toBe(0);
  await expect(queue.write(1, draftArgs, backend)).resolves.toEqual({ revision: 1 });
});

test("aggregate byte capacity is restored after an in-flight write drains", async () => {
  const queue = new DesktopFileDraftWrites();
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const backend = {
    invoke: async () => {
      await held;
      return { revision: 1 };
    },
  };
  const args = { ...draftArgs, content: "x".repeat(33 * 1024 * 1024) };
  const first = queue.write(1, args, backend);
  await expect(queue.write(1, args, backend)).rejects.toThrow("write capacity");
  resume();
  await first;
  await expect(queue.write(1, args, savedBackend)).resolves.toEqual({ revision: 1 });
});

test("release removes a failed cursor after its queued successors reject", async () => {
  const queue = new DesktopFileDraftWrites();
  const backend = {
    invoke: () => {
      throw new Error("conflict");
    },
  };
  const pending = [
    queue.write(1, draftArgs, backend).catch(() => undefined),
    queue.write(1, draftArgs, backend).catch(() => undefined),
  ];
  queue.releaseClient(1, "client");
  await Promise.all(pending);
  await expect(queue.write(1, draftArgs, savedBackend)).resolves.toEqual({ revision: 1 });
});
