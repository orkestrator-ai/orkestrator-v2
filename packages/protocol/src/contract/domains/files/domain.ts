/**
 * The `files` contract domain (docs/reports/unified-federation.md §11.2, plan
 * item 7002): an environment's workspace files as the files panel, the editor
 * and attachments read and change them, in a local worktree or a container.
 * Version 1 until a change an older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const filesDomain = defineDomain({ name: "files", version: 1 });
