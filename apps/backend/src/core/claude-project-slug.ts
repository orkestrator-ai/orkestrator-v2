/**
 * Claude Code's name for the folder that holds a working directory's
 * transcripts (`<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl`): every
 * character that is not an ASCII letter or digit becomes `-`, and a name
 * longer than 200 characters is cut there and given the path's hash. A slug
 * that only replaced `/` missed every worktree whose path has a space, a dot
 * or an underscore, which on macOS is every one under `Application Support`
 * (to-do 5160 task 7).
 */

const CLAUDE_SLUG_MAX = 200;

/** Claude Code's 32-bit string hash, used to shorten long transcript folder names. */
function claudeStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Claude Code's transcript folder name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CLAUDE_SLUG_MAX) return slug;
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(claudeStringHash(cwd)).toString(36)}`;
}
