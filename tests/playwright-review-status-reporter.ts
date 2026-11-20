import type { FullResult, Reporter } from "@playwright/test/reporter";

/** Preserve the list reporter's timeout output and give interruption its own exit status. */
export default class ReviewStatusReporter implements Reporter {
  async onEnd(result: FullResult): Promise<{ status: "interrupted" } | undefined> {
    if (result.status === "timedout") return { status: "interrupted" };
  }
}
