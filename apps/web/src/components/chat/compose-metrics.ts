/**
 * Composer input sizing, shared so all three agents' inputs grow identically.
 *
 * Codex previously capped at 160px while Claude and OpenCode grew to 256px, so
 * the same prompt scrolled in one tab and not the others.
 */
export const COMPOSE_LINE_HEIGHT = 20;
export const COMPOSE_MAX_LINES = 12;
export const COMPOSE_MIN_INPUT_HEIGHT = COMPOSE_LINE_HEIGHT + 8;
export const COMPOSE_MAX_INPUT_HEIGHT = COMPOSE_MAX_LINES * COMPOSE_LINE_HEIGHT + 16;
