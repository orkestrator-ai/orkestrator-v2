import { expect, test } from "bun:test";
import path from "node:path";
import { superviseWorker } from "./preview-supervisor.js";

for (const source of ["split-utf8", "malformed", "output-limit"]) {
  test(`stdout framing: ${source}`, async () => {
    const worker = superviseWorker(
      {
        isolation: "process",
        command: process.execPath,
        args: [path.join(import.meta.dir, "fixtures/fake-preview-worker.ts")],
      },
      { job: { kind: "mermaid", source, theme: "light" } } as Parameters<typeof superviseWorker>[1],
      { workerWallMs: 5000, readinessHardMs: 3000, mermaidRenderMs: 3000, cleanupGraceMs: 100 },
    );
    try {
      const outcome = await worker.outcome;
      if (source === "split-utf8") {
        expect(outcome.type).toBe("result");
        if (outcome.type === "result") expect(outcome.result.effectiveHtml).toBe("<p>漢字 😀</p>");
      } else
        expect(outcome).toMatchObject({
          type: "crashed",
          reason: source === "malformed" ? "protocol" : "output-limit",
        });
    } finally {
      worker.cancel();
      expect((await worker.exited).verified).toBe(true);
    }
  }, 10000);
}
