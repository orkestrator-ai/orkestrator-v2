import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { readComposerFileIndex } from "./composer-file-index";

const windows: WindowScope[] = [];

function createScope() {
  const window = new WindowScope();
  windows.push(window);
  return window.open({ role: "command", client: new FakeNodeClient() });
}

afterEach(() => {
  for (const window of windows.splice(0)) window.dispose();
});

function snapshot(filename: string) {
  return {
    unchanged: false,
    digest: filename,
    value: [{ name: filename, path: filename, isDirectory: false }],
  };
}

test("joins reads at the pending limit and holds no slot after a failed read", async () => {
  const scope = createScope();
  const loads = Array.from({ length: 8 }, () =>
    Promise.withResolvers<ReturnType<typeof snapshot>>(),
  );
  const requests = loads.map((load, index) =>
    readComposerFileIndex(scope, `workspace-${index}`, () => load.promise),
  );
  const unexpectedRead = mock(async () => snapshot("unexpected.ts"));
  const joined = readComposerFileIndex(scope, "workspace-0", unexpectedRead);
  const readNinth = mock(async () => snapshot("ninth.ts"));

  try {
    await expect(readComposerFileIndex(scope, "ninth", readNinth)).rejects.toThrow(
      "Too many workspace file reads",
    );
    expect(readNinth).not.toHaveBeenCalled();

    loads[1]!.reject(new Error("Read failed"));
    await expect(requests[1]).rejects.toThrow("Read failed");

    const ninth = await readComposerFileIndex(scope, "ninth", readNinth);
    expect(ninth[0]?.relativePath).toBe("ninth.ts");
    expect(readNinth).toHaveBeenCalledTimes(1);
    loads[0]!.resolve(snapshot("shared.ts"));
    expect(await joined).toBe(await requests[0]!);
    expect(unexpectedRead).not.toHaveBeenCalled();
  } finally {
    for (const load of loads) load.resolve(snapshot("settled.ts"));
    await Promise.allSettled([...requests, joined]);
  }
});

test("evicts the least recently used completed index at capacity", async () => {
  const scope = createScope();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  const read = mock(async () => snapshot("cached.ts"));
  try {
    const recent = await readComposerFileIndex(scope, "first", read);
    for (let workspace = 1; workspace < 8; workspace++) {
      await readComposerFileIndex(scope, String(workspace), read);
    }
    expect(await readComposerFileIndex(scope, "first", read)).toBe(recent);
    await readComposerFileIndex(scope, "ninth", read);

    expect(await readComposerFileIndex(scope, "first", read)).toBe(recent);
    expect(read).toHaveBeenCalledTimes(9);
    await readComposerFileIndex(scope, "1", read);
    expect(read).toHaveBeenCalledTimes(10);
    expect(read).toHaveBeenLastCalledWith(undefined);
  } finally {
    clock.mockRestore();
  }
});

test("rejects an unchanged snapshot whose digest does not match the retained index", async () => {
  const scope = createScope();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    await readComposerFileIndex(scope, "workspace", async () => snapshot("old.ts"));
    clock.mockReturnValue(3_000);
    const read = mock(async () => ({ unchanged: true, digest: "unexpected" }));
    await expect(readComposerFileIndex(scope, "workspace", read)).rejects.toThrow(
      "Missing workspace file index",
    );
    expect(read).toHaveBeenCalledWith("old.ts");

    const recover = mock(async () => snapshot("current.ts"));
    const files = await readComposerFileIndex(scope, "workspace", recover);
    expect(recover).toHaveBeenCalledWith(undefined);
    expect(files[0]?.relativePath).toBe("current.ts");
  } finally {
    clock.mockRestore();
  }
});

test("discards a deferred result when its node is disposed mid-read", async () => {
  const scope = createScope();
  const load = Promise.withResolvers<ReturnType<typeof snapshot>>();
  const read = mock(() => load.promise);
  const request = readComposerFileIndex(scope, "workspace", read);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  scope.dispose();
  load.resolve(snapshot("disconnected.ts"));
  await expect(request).rejects.toThrow("The workspace node is disconnected");

  const freshRead = mock(async () => snapshot("connected.ts"));
  const files = await readComposerFileIndex(createScope(), "workspace", freshRead);
  expect(freshRead).toHaveBeenCalledWith(undefined);
  expect(files[0]?.relativePath).toBe("connected.ts");
});
