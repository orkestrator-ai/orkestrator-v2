/**
 * Which `gh` the backend runs on its own host.
 *
 * Orkestrator installs a pinned, checksum-verified `gh` with the agent CLIs,
 * and its terminals and agents find that copy first on PATH. The backend's own
 * GitHub calls use it too; both share gh's configuration and login. Without
 * one (Windows, or a toolchain that failed to install), `gh` is looked up on
 * PATH.
 *
 * Kept free of imports so any module can resolve it without a cycle.
 */

let managedGitHubCli: string | undefined;

/** Set once at startup from the backend's activated toolchain. */
export function setManagedGitHubCli(executable: string | undefined): void {
  managedGitHubCli = executable;
}

/** The `gh` to run on the backend host. */
export function gitHubCli(): string {
  return managedGitHubCli ?? "gh";
}
