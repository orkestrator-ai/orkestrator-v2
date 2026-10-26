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
