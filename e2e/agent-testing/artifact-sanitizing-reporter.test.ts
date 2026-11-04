import { expect, spyOn, test } from "bun:test";
import type { FullConfig } from "@playwright/test/reporter";
import * as teardown from "./global-teardown";
import * as churn from "./network-churn-report";
import ArtifactSanitizingReporter from "./artifact-sanitizing-reporter";

test("onExit sanitizes the selected suite before reporting the resolved output directory", async () => {
  const events: string[] = [];
  const sanitize = spyOn(teardown, "sanitizeRunArtifacts").mockImplementation(async (suite) => {
    events.push(`sanitize:${suite}`);
  });
  const report = spyOn(churn, "networkChurnReport").mockImplementation((directory) => {
    events.push(`report:${directory}`);
    return "network churn summary";
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const reporter = new ArtifactSanitizingReporter({ suite: "goals" });
    reporter.onBegin({ projects: [{ outputDir: "/isolated/artifacts" }] } as FullConfig);
    await reporter.onExit();
    expect(events).toEqual(["sanitize:goals", "report:/isolated/artifacts"]);
    expect(log).toHaveBeenCalledWith("network churn summary");
    report.mockReturnValue(null);
    log.mockClear();
    await reporter.onExit();
    expect(log).not.toHaveBeenCalled();
    report.mockClear();
    const empty = new ArtifactSanitizingReporter();
    empty.onBegin({ projects: [] } as unknown as FullConfig);
    await empty.onExit();
    expect(sanitize).toHaveBeenLastCalledWith("browser");
    expect(report).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally {
    sanitize.mockRestore();
    report.mockRestore();
    log.mockRestore();
  }
});
