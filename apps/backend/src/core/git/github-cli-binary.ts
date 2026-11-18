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

/**
 * One backend's `gh`: the pinned copy from its toolchain, or the newest
 * release under its data directory when the gh channel follows upstream.
 * Held on `BackendRuntime.gitHubCli`, so two backends in one process never
 * run each other's binary (docs/architecture/backend-runtime.md).
 */
export class GitHubCliSelection {
  private pinnedExecutable: string | undefined;
  private selected: string | undefined;

  /** Records the toolchain's pinned `gh` at startup and selects it. */
  pin(executable: string | undefined): void {
    this.pinnedExecutable = executable;
    this.selected = executable;
  }

  /** The toolchain's pinned `gh`; undefined when the toolchain has none. */
  get pinned(): string | undefined {
    return this.pinnedExecutable;
  }

  /** Follows the gh channel: a downloaded release, or the pin again. */
  select(executable: string | undefined): void {
    this.selected = executable;
  }

  /** The managed `gh` in use; undefined when `gh` comes from PATH. */
  managed(): string | undefined {
    return this.selected;
  }
}

/**
 * The `gh` to run on the backend host. Absent a selection (a fixture with no
 * runtime), `gh` comes from PATH, as `gitHubCliEnv` without a source uses the
 * host login.
 */
export function gitHubCli(selection: GitHubCliSelection | undefined): string {
  return selection?.managed() ?? "gh";
}
