/**
 * Backend rollout switch for web annotations: `enabled` (default),
 * `read-only` (recovery), or `disabled`.
 *
 * The persisted setting is `config.global.webAnnotations.mode`; the
 * `ORKESTRATOR_WEB_ANNOTATIONS_MODE` environment variable overrides it (for
 * an emergency rollback without touching user settings). The mode is cached
 * so command gating is synchronous; a failed settings read keeps the last
 * known mode rather than silently widening or closing access.
 *
 * Changing the mode never touches persisted data, and the backend reconciler
 * keeps settling requests that were already sent in every mode.
 */
import {
  DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE,
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_ROLLOUT_ENV,
  normalizeWebAnnotationRolloutSettings,
  parseWebAnnotationRolloutOverride,
  type WebAnnotationRolloutMode,
  type WebAnnotationRolloutSnapshot,
} from "@orkestrator/protocol/web-annotations";

export class WebAnnotationRollout {
  private configured: WebAnnotationRolloutMode = DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE;
  private readonly override: WebAnnotationRolloutMode | null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly load: () => Promise<unknown> = async () => undefined,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.override = parseWebAnnotationRolloutOverride(env[WEB_ANNOTATION_ROLLOUT_ENV]);
  }

  get mode(): WebAnnotationRolloutMode {
    return this.override ?? this.configured;
  }

  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      try {
        this.configured = normalizeWebAnnotationRolloutSettings(await this.load()).mode;
      } catch {
        // Keep the last known mode.
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = run;
    return run;
  }

  /** Apply a mode that was just persisted. */
  setConfigured(mode: WebAnnotationRolloutMode): void {
    this.configured = mode;
  }

  snapshot(): WebAnnotationRolloutSnapshot {
    return { mode: this.mode, configured: this.configured, override: this.override };
  }
}

/**
 * Access class of each public command:
 *
 * - `always`: capabilities and operator surfaces (usable in every mode).
 * - `read`: reads of threads, captures, assets, requests, changes.
 * - `resolve`: human resolution management.
 * - `draft`: unsent editor drafts (kept in read-only so typing is not lost).
 * - `recover`: requests already sent (inspect/cancel/recover/response).
 * - `author`: anything that creates feedback, captures, migrates, or dispatches.
 *
 * `enabled` allows everything; `read-only` allows all but `author`;
 * `disabled` allows only `always`. Unlisted commands are `author`.
 */
export type WebAnnotationCommandAccess =
  | "always"
  | "read"
  | "resolve"
  | "draft"
  | "recover"
  | "author";

const c = WEB_ANNOTATION_COMMANDS;
const ACCESS: Record<string, WebAnnotationCommandAccess> = {
  [c.capabilities]: "always",
  [c.rollout]: "always",
  [c.rolloutSet]: "always",
  [c.metrics]: "always",
  [c.list]: "read",
  [c.changes]: "read",
  [c.get]: "read",
  [c.entries]: "read",
  [c.capture]: "read",
  [c.receipt]: "read",
  [c.assetGet]: "read",
  [c.migrationStatus]: "read",
  [c.draftGet]: "draft",
  [c.draftSave]: "draft",
  [c.draftDelete]: "draft",
  [c.resolve]: "resolve",
  [c.reopen]: "resolve",
  [c.destinations]: "recover",
  [c.requestGet]: "recover",
  [c.requestList]: "recover",
  [c.requestCancel]: "recover",
  [c.requestRecover]: "recover",
  [c.requestResponse]: "recover",
};

export function webAnnotationCommandAccess(command: string): WebAnnotationCommandAccess {
  return ACCESS[command] ?? "author";
}

export function webAnnotationAccessAllowed(
  mode: WebAnnotationRolloutMode,
  access: WebAnnotationCommandAccess,
): boolean {
  if (access === "always") return true;
  if (mode === "enabled") return true;
  if (mode === "disabled") return false;
  return access !== "author";
}
