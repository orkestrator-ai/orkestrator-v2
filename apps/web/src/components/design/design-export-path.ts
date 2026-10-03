/** Mirrors the backend rule: a repository-relative path of plain folders ending in `.orkdes`. */
export const DESIGN_EXPORT_NAME =
  /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/){0,7}[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.orkdes$/;
export const DESIGN_EXPORT_PATH_MAX = 240;
