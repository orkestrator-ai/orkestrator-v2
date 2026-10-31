/**
 * Added Claude accounts' copies of the backend user's Claude MCP servers.
 *
 * An added account's CLI runs with `CLAUDE_CONFIG_DIR` set to the account's
 * directory, so it reads that directory's `.claude.json`, which
 * `syncClaudeAccountSettings` fills with the host file's servers (top-level
 * and each project's). The bridge keeps reading the host file. The copy is
 * made before every launch, and here after every save of the host file, so a
 * CLI the bridge starts later (after an idle close) loads what was saved
 * rather than what the copy held when the bridge started. A server the copy
 * still names that the host file does not is reported stale and refused by
 * the bridge (`claudeAccountOnlyMcpServerNames`).
 */

import path from "node:path";

import { hostClaudeJsonPath, syncClaudeAccountSettings } from "../agent-accounts-homes.js";
import type { SourceSpec } from "./types.js";

export const CLAUDE_ACCOUNT_COPY_NOTE =
  "Added Claude accounts use their own copy of these servers. Orkestrator replaces each copy with this file's servers when you save here and before it starts Claude on an account, so servers added inside an account's own configuration are overwritten, and Orkestrator sessions do not use them.";

/** The directories of the added Claude accounts that exist on disk. */
export type ClaudeAccountHomes = () => Promise<string[]>;

const COPIED_SOURCES = new Set(["claude:user", "claude:local"]);

export class ClaudeAccountCopies {
  private readonly hostJson: string;

  constructor(
    private readonly homes: ClaudeAccountHomes | undefined,
    env: NodeJS.ProcessEnv,
    home: string,
  ) {
    this.hostJson = path.resolve(hostClaudeJsonPath(env, home));
  }

  /**
   * Whether accounts copy this source. Only when the copy's source is the
   * file the editor writes: with the backend's own `CLAUDE_CONFIG_DIR` set,
   * accounts copy that directory's file instead.
   */
  private copied(spec: SourceSpec): boolean {
    return (
      spec.provider === "claude" &&
      !spec.container &&
      COPIED_SOURCES.has(spec.sourceId) &&
      path.resolve(spec.path) === this.hostJson
    );
  }

  private async list(): Promise<string[]> {
    if (!this.homes) return [];
    return this.homes().catch(() => []);
  }

  /** Say so on the Claude sources accounts copy, when any account exists. */
  async note(specs: SourceSpec[]): Promise<void> {
    const copied = specs.filter((spec) => this.copied(spec));
    if (!copied.length || !(await this.list()).length) return;
    for (const spec of copied) {
      spec.note = spec.note ? `${spec.note} ${CLAUDE_ACCOUNT_COPY_NOTE}` : CLAUDE_ACCOUNT_COPY_NOTE;
    }
  }

  /**
   * Refresh every account's copy after `spec` was saved. Best effort: a busy
   * lock or an unreadable copy is left for the next launch, which copies
   * again, and the bridge reports what the copy still names meanwhile.
   */
  async refresh(spec: SourceSpec): Promise<void> {
    if (!this.copied(spec)) return;
    for (const home of await this.list()) {
      await syncClaudeAccountSettings(home, this.hostJson).catch(() => undefined);
    }
  }
}
