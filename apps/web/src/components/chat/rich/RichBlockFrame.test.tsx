import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { RichBlockFrame } from "./RichBlockFrame";

function ThrowingBody(): never {
  throw new TypeError("block source: const answer = 42");
}

afterEach(cleanup);

describe("RichBlockFrame", () => {
  test("logs a failed renderer without its message, source or location", () => {
    const logs = captureLogs();
    try {
      render(
        <RichBlockFrame title="Block" kind="mermaid" fallback={<pre>exact source</pre>}>
          <ThrowingBody />
        </RichBlockFrame>,
      );

      expect(screen.getByText("exact source")).toBeTruthy();
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "web.chat",
          event: "rich-block.render-failed",
          fields: expect.objectContaining({
            kind: "mermaid",
            errorType: "TypeError",
            component: "ThrowingBody",
          }),
        }),
      );
      const output = logs.lines.join("\n");
      expect(output).not.toContain("const answer");
      expect(output).not.toContain("exact source");
      expect(output).not.toContain("RichBlockFrame.test");
    } finally {
      logs.restore();
    }
  });
});
