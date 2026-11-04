import { expect, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const { createTempDir, createContext, createEnvironment, createCommandRegistry, fs, path } =
  await createCommandFixtures();

test("get_local_file_subtree reads fresh directory contents through the registered handler", async () => {
  const worktreePath = await createTempDir("ork-local-subtree-");
  await fs.mkdir(path.join(worktreePath, "nested"));
  await fs.writeFile(path.join(worktreePath, "nested", "first.txt"), "first");
  const { context } = createContext(createEnvironment({ environmentType: "local", worktreePath }));
  const handler = createCommandRegistry().get("get_local_file_subtree");
  expect(handler).toBeDefined();
  const args = { worktreePath, directory: "nested" };
  expect(await handler!(args, context)).toMatchObject({
    children: [{ path: "nested/first.txt", isDirectory: false }],
    truncated: false,
  });
  await fs.unlink(path.join(worktreePath, "nested", "first.txt"));
  await fs.writeFile(path.join(worktreePath, "nested", "second.txt"), "second");
  expect(await handler!(args, context)).toMatchObject({
    children: [{ path: "nested/second.txt" }],
    truncated: false,
  });
  await expect(handler!({ worktreePath, directory: "../outside" }, context)).rejects.toThrow();
});

test("get_local_file_subtree answers an unchanged directory with no contents", async () => {
  const worktreePath = await createTempDir("ork-local-subtree-digest-");
  await fs.mkdir(path.join(worktreePath, "nested"));
  await fs.writeFile(path.join(worktreePath, "nested", "first.txt"), "first");
  const { context } = createContext(createEnvironment({ environmentType: "local", worktreePath }));
  const handler = createCommandRegistry().get("get_local_file_subtree")!;
  const read = (knownDigest: string) =>
    handler({ worktreePath, directory: "nested", knownDigest }, context) as Promise<{
      unchanged: boolean;
      digest: string;
      value?: { children: Array<{ path: string }> };
    }>;

  const first = await read("");
  expect(first.unchanged).toBe(false);
  expect(first.digest).not.toBe("");
  expect(first.value?.children.map(({ path: child }) => child)).toEqual(["nested/first.txt"]);

  // Nothing changed: the digest comes back and the contents do not.
  expect(await read(first.digest)).toEqual({ unchanged: true, digest: first.digest });

  // A folder change must still appear.
  await fs.writeFile(path.join(worktreePath, "nested", "second.txt"), "second");
  const changed = await read(first.digest);
  expect(changed.unchanged).toBe(false);
  expect(changed.digest).not.toBe(first.digest);
  expect(changed.value?.children.map(({ path: child }) => child)).toEqual([
    "nested/first.txt",
    "nested/second.txt",
  ]);
});
