/**
 * The `claude-tmux` contract domain (docs/reports/unified-federation.md §11.2).
 * Version 1 until a change an older peer cannot handle silently; its
 * commands (Phase 7) and events (`./events.ts`) share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const claudeTmuxDomain = defineDomain({ name: "claude-tmux", version: 1 });
