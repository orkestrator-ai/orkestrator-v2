import { afterEach, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { writeBugReportAttachment } from "./bug-report";

// The shared setup owns the invoke mock; this suite changes only its behavior.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

test("stages a pasted image by report ID and returns its backend-owned destination", async () => {
  invokeMock.mockResolvedValue("/tmp/report/screenshots/paste.png");
  await expect(writeBugReportAttachment("report-1", "clipboard.png", "cG5n")).resolves.toBe(
    "/tmp/report/screenshots/paste.png",
  );
  expect(invokeMock).toHaveBeenCalledTimes(1);
  expect(invokeMock).toHaveBeenCalledWith("write_bug_report_attachment", {
    reportId: "report-1",
    filename: "clipboard.png",
    base64Data: "cG5n",
  });
});

test("a refused report attachment propagates without a raw-path fallback", async () => {
  invokeMock.mockRejectedValue(new Error("This bug report was discarded"));
  await expect(writeBugReportAttachment("gone", "clipboard.png", "cG5n")).rejects.toThrow(
    "discarded",
  );
  expect(invokeMock).toHaveBeenCalledTimes(1);
});
