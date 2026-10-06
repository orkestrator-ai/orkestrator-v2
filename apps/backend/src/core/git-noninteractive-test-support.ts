import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./shell.js";

/** Isolated SSH fixture that models OpenSSH's first-value-wins option handling. */
export async function createNonInteractiveGitFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-git-ssh-")));
  const repo = path.join(root, "repo");
  const binDir = path.join(root, "bin with spaces");
  const log = path.join(root, "ssh.log");
  const gitconfig = path.join(root, "gitconfig");
  await fs.mkdir(binDir);
  await fs.writeFile(gitconfig, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
  };
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_SSH;
  const git = (args: string[], cwd = repo) => runCommand("git", args, { cwd, env });
  await fs.mkdir(repo);
  await git(["init", "-q", "-b", "main"]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  ]);
  const ssh = path.join(binDir, "ssh");
  await fs.writeFile(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$GIT_TERMINAL_PROMPT $*" >> '${log}'
batch=''
for arg in "$@"; do
  case "$arg" in
    BatchMode=*|-oBatchMode=*)
      if [ -z "$batch" ]; then batch="\${arg##*=}"; fi ;;
  esac
done
if [ "$batch" = yes ]; then
  echo "git@example.invalid: Permission denied (publickey)." >&2
  exit 255
fi
sleep 2
echo "interactive SSH fixture reached prompt" >&2
exit 255
`,
  );
  await fs.chmod(ssh, 0o755);
  return {
    root,
    repo,
    binDir,
    env,
    ssh,
    git,
    command: `'${ssh}'`,
    readLog: () => fs.readFile(log, "utf8").catch(() => ""),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
