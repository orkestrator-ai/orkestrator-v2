import { CommandFailedError } from "./shell.js";

/** Blank every configured filter before a host read can hash worktree bytes. */
export async function neutralizeGitFilters(
  git: (args: string[]) => Promise<string>,
): Promise<string[]> {
  const output = await git(["config", "-z", "--get-regexp", "^filter\\."]).catch((error) => {
    // Git exits 1 for no matching keys. Any other error must stop the scan.
    if (error instanceof CommandFailedError && error.exitCode === 1) return "";
    throw error;
  });
  const names = new Set<string>();
  for (const record of output.split("\0")) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(
      record.split("\n", 1)[0] ?? "",
    );
    if (match?.[1]) names.add(match[1]);
  }
  return Array.from(names).flatMap((name) =>
    ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => [
      "-c",
      `filter.${name}.${setting}`,
    ]),
  );
}
