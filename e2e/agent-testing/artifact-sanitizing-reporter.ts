import type { Reporter } from "@playwright/test/reporter";
import { sanitizeRunArtifacts } from "./global-teardown";

/**
 * Redacts the suite's artifacts once every reporter has written its output.
 *
 * Global teardown runs before reporters finish, so it never sees the JSON
 * reporter's `results.json`, whose error call logs carry the gateway cookie of
 * a request that failed (a backend that went away mid-test, for example).
 * `onExit` runs after every reporter's `onEnd`. List this reporter last.
 */
export default class ArtifactSanitizingReporter implements Reporter {
  private readonly suite: "browser" | "coordinator";

  constructor(options: { suite?: "browser" | "coordinator" } = {}) {
    this.suite = options.suite ?? "browser";
  }

  printsToStdio(): boolean {
    return false;
  }

  async onExit(): Promise<void> {
    await sanitizeRunArtifacts(this.suite);
  }
}
