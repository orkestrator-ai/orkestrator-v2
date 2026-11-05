import { expect, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const fixtures = await createCommandFixtures();
const { createTempDir, createContext, createEnvironment, createCommandRegistry, fs, path } =
  fixtures;

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

test("get_file_subtree answers an unchanged container directory with no contents", async () => {
  const { withFakeDocker } = fixtures;
  const listing = path.join(await createTempDir("ork-container-subtree-digest-"), "listing");
  const list = (...files: string[]) =>
    fs.writeFile(listing, files.map((file) => `f\t${file}\0`).join(""));
  await list("nested/first.txt");
  const { context } = createContext(
    createEnvironment({
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    }),
  );
  const handler = createCommandRegistry().get("get_file_subtree")!;
  const read = (knownDigest?: string) =>
    handler({ containerId: "container-1", directory: "nested", knownDigest }, context) as Promise<{
      unchanged: boolean;
      digest: string;
      value?: { children: Array<{ path: string }> };
    }>;

  await withFakeDocker(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  cat '${listing}'
  exit 0
fi
exit 1
`,
    async (logs) => {
      // Without a digest the command answers in its original shape.
      expect(await read()).toMatchObject({ children: [{ path: "nested/first.txt" }] });

      const first = await read("");
      expect(first.unchanged).toBe(false);
      expect(first.value?.children.map(({ path: child }) => child)).toEqual(["nested/first.txt"]);

      // Nothing changed: the digest comes back and the contents do not.
      expect(await read(first.digest)).toEqual({ unchanged: true, digest: first.digest });

      // The directory is still listed on every read, so a change appears.
      await list("nested/first.txt", "nested/second.txt");
      const changed = await read(first.digest);
      expect(changed.unchanged).toBe(false);
      expect(changed.digest).not.toBe(first.digest);
      expect(changed.value?.children.map(({ path: child }) => child)).toEqual([
        "nested/first.txt",
        "nested/second.txt",
      ]);
      const execs = (await fs.readFile(logs.exec, "utf8")).trim().split("\n");
      expect(execs.filter((line) => line.startsWith("exec "))).toHaveLength(4);
    },
  );
});
