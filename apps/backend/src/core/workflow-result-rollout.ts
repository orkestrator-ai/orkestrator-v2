import type { StructuredOutputProvider } from "@orkestrator/protocol/structured-output";
import {
  DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS,
  normalizeWorkflowResultToolsSettings,
  type WorkflowResultKind,
  type WorkflowResultToolsSettings,
} from "@orkestrator/protocol/workflow-results";

/**
 * Backend-owned admission gate for tool-mode workflow results.
 *
 * Admission is decided once, when an attempt is admitted, and the choice is
 * then persisted on the attempt. Configuration changes therefore affect new
 * attempts only: an in-flight tool-mode slot keeps its tools and its receipt
 * even after the combination is switched off, which is what makes disabling a
 * combination a safe rollback rather than a way to strand live work.
 *
 * The decision has to be readable synchronously from inside storage mutation
 * callbacks, so the settings are cached and refreshed at the async points that
 * precede admission.
 */
export class WorkflowResultRollout {
  private settings: WorkflowResultToolsSettings = {
    ...DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS,
  };
  private inflight: Promise<void> | null = null;

  constructor(private readonly load: () => Promise<unknown>) {}

  /**
   * Refreshes the cached settings. Concurrent callers share one read. A failed
   * read keeps the previous snapshot rather than silently widening or closing
   * admission.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      try {
        this.settings = normalizeWorkflowResultToolsSettings(await this.load());
      } catch {
        // Keep the last known settings.
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = run;
    return run;
  }

  /**
   * Configuration can only narrow the qualified set, never widen it.
   *
   * Qualification is a property of the code: a provider is qualified once its
   * adapter can actually receive a per-turn capability, and that cannot be
   * granted by editing a setting. Without this intersection, naming an
   * unqualified provider here would prepare a result slot and dispatch a turn
   * the model has no way to submit against, stranding the workflow until its
   * recovery deadline.
   */
  allows(provider: StructuredOutputProvider, kind: WorkflowResultKind): boolean {
    return (
      this.settings.enabled &&
      QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS.includes(provider) &&
      this.settings.providers.includes(provider) &&
      this.settings.kinds.includes(kind)
    );
  }

  snapshot(): WorkflowResultToolsSettings {
    return {
      enabled: this.settings.enabled,
      providers: [...this.settings.providers],
      kinds: [...this.settings.kinds],
    };
  }
}
