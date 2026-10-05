import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRemoteWorktreeStartPoint } from "./commands-files.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Puts a `git` first on PATH that records the fetch's environment, then succeeds. */
async function useRecordingGit(
  options: { sshCommandConfig?: string } = {},
): Promise<{ recorded: () => Promise<string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-remote-fetch-"));
  const record = path.join(root, "fetch-env.txt");
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    fetch) printf 'prompt=%s ssh=%s' "$GIT_TERMINAL_PROMPT" "$GIT_SSH_COMMAND" > '${record}'; exit 0 ;;
    config) ${options.sshCommandConfig ? `printf '%s\\n' '${options.sshCommandConfig}'; exit 0` : "exit 1"} ;;
    rev-parse) exit 0 ;;
  esac
done
exit 0
`,
  );
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const originalPath = process.env.PATH;
  const originalSsh = process.env.GIT_SSH_COMMAND;
  const originalGitSsh = process.env.GIT_SSH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  cleanups.push(async () => {
    process.env.PATH = originalPath;
    if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = originalSsh;
    if (originalGitSsh === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = originalGitSsh;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { recorded: () => fs.readFile(record, "utf8") };
}

describe("resolveRemoteWorktreeStartPoint", () => {
  test("fetches without any chance of prompting on the backend's terminal", async () => {
    const git = await useRecordingGit();

    await resolveRemoteWorktreeStartPoint("/repo", "main");

    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -o BatchMode=yes");
  });

  test("keeps a configured ssh command and only adds BatchMode", async () => {
    const git = await useRecordingGit({ sshCommandConfig: "ssh -i /keys/work" });

    await resolveRemoteWorktreeStartPoint("/repo", "main");

    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -i /keys/work -o BatchMode=yes");
  });
});
