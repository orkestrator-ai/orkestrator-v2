export const CONTAINER_SLASH_COMMAND_DIRECTORY = "/workspace";

export function resolveSlashCommandDirectory(
  isLocal: boolean,
  worktreePath?: string,
): string | undefined {
  if (!isLocal) {
    return CONTAINER_SLASH_COMMAND_DIRECTORY;
  }

  if (!worktreePath) {
    return undefined;
  }

  const trimmed = worktreePath.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function shouldLoadSlashCommands(
  isLocal: boolean,
  directory?: string,
): boolean {
  if (!isLocal) {
    return true;
  }

  return Boolean(directory);
}
