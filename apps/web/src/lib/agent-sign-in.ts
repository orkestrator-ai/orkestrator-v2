/**
 * Where a native tab sends the user when its platform needs a sign-in it
 * cannot run from the tab itself.
 *
 * The login commands are fixed here rather than taken from the bridge: a
 * bridge inside a container is not trusted to choose what a terminal runs.
 * Claude has its own card (`ClaudeAuthRecoveryCard`), and Codex and Cursor
 * sign in from the tab through `beginSignIn`.
 */

/** The command a plain terminal tab runs to sign the platform in. */
export function agentTerminalSignInCommand(platform: string): string | undefined {
  switch (platform) {
    case "grok":
      return "grok login";
    case "opencode":
      return "opencode auth login";
    // Pi's login is its own interactive `/login`, which an initial message
    // cannot run, so the tab opens Pi and the hint names the command.
    case "pi":
      return "pi";
    default:
      return undefined;
  }
}

/** Platforms whose settings section can sign the account in. */
export function agentSettingsCanSignIn(platform: string): boolean {
  return platform === "codex" || platform === "cursor" || platform === "opencode";
}
