/**
 * Every `reason` a failed command can log, with a sentence saying what it means.
 * A label is static text chosen here, never built from a command's output, so a
 * review of a new reason is a review of this list. `classifyCommandFailure`
 * (`node/command-failure-reason.ts`) decides which one applies.
 */
export const COMMAND_FAILURE_REASONS = {
  // How the process ended.
  "timed-out": "The command ran past its deadline and was killed.",
  aborted: "The caller or the tool's own cancel path stopped the command on request.",
  killed: "A signal the caller did not send ended the command.",
  "executable-missing": "The program or its working directory does not exist, so nothing ran.",
  "output-too-large": "The command wrote more than the capture limit and was killed.",
  "command-not-found": "A shell could not find the program it was asked to run.",
  "not-executable": "A shell found the program but could not run it.",
  // Any tool.
  "auth-failed": "The command had no credentials, or the remote refused the ones it sent.",
  "network-failed": "The command could not reach a remote host or lost the connection.",
  "disk-full": "The filesystem or quota had no room for what the command wrote.",
  "permission-denied": "The operating system refused access to a file or directory.",
  "path-not-found": "A file or directory the command needed does not exist.",
  "port-in-use": "The port the command wanted to bind is already taken.",
  "invalid-usage": "The tool rejected its arguments, which usually means a bug in the caller.",
  // Git.
  "branch-exists": "The target branch name is already taken.",
  "branch-not-found": "The branch the command named does not exist.",
  "invalid-ref": "A branch name or revision is malformed or does not resolve.",
  "ref-conflict": "A ref cannot be created because an existing ref occupies its path.",
  "lock-held": "Another git process, or a stale lock file, holds a lock this one needs.",
  "not-a-repository": "The working directory is not inside a git repository.",
  "worktree-conflict": "Another worktree already has the branch or path checked out.",
  "merge-conflict": "A merge, rebase or cherry-pick stopped on conflicting changes.",
  "dirty-worktree": "Uncommitted changes would be overwritten, so git refused.",
  "nothing-to-commit": "There were no staged changes to commit.",
  "push-rejected": "The remote refused the push, by a hook, protection or a non-fast-forward.",
  "remote-ref-missing": "The ref asked for does not exist on the remote.",
  "no-remote": "The remote is not configured, or its repository cannot be found.",
  "dubious-ownership": "Git refused a repository owned by another user.",
  "identity-unknown": "Git has no user name or email to commit with.",
  // GitHub CLI.
  "rate-limited": "GitHub refused the request because of an API rate limit.",
  forbidden: "GitHub refused the request: the token lacks access to the resource.",
  "resource-not-found": "GitHub has no such resource, or the token cannot see it.",
  "no-pull-request": "No pull request matched the branch or filter.",
  "pull-request-exists": "The branch already has an open pull request.",
  "server-error": "GitHub answered with a server error.",
  // Docker.
  "daemon-unavailable": "The Docker daemon is not running or cannot be reached.",
  "daemon-error": "Docker itself failed before running anything in the container.",
  "container-not-found": "The container no longer exists.",
  "container-not-running": "The container exists but is stopped, paused or restarting.",
  "container-name-conflict": "Another container already has that name.",
  "image-not-found": "The image does not exist locally or could not be pulled.",
  // Tmux.
  "server-not-running": "There is no tmux server to talk to.",
  "session-not-found": "The tmux session, window or pane does not exist.",
  "session-exists": "A tmux session with that name already exists.",
  // Fallback.
  unclassified: "Nothing above matched; the entry's exit code and signal are the evidence.",
} as const;

export type CommandFailureReason = keyof typeof COMMAND_FAILURE_REASONS;
