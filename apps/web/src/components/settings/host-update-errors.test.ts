import { expect, test } from "bun:test";
import { summarizeUpdateError, updateErrorDetails } from "./host-update-errors";

const MISSING_MAC_FILE =
  "Cannot find latest-mac.yml in the latest release artifacts " +
  "(https://github.com/orkestrator-ai/orkestrator-v2/releases/download/v2.36.6-beta/latest-mac.yml): " +
  'HttpError: 404 \n"method: GET url: https://github.com/orkestrator-ai/orkestrator-v2/releases/download/v2.36.6-beta/latest-mac.yml\\n\\nPlease double check that your authentication token is correct."\n' +
  'Headers: { "cache-control": "no-cache" }';

test("a release without this platform's files is named, not dumped", () => {
  expect(summarizeUpdateError(MISSING_MAC_FILE)).toBe(
    "v2.36.6-beta has no macOS update files yet; it may still be publishing.",
  );
  expect(
    summarizeUpdateError(
      "Cannot find beta-linux.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.2.0-beta/beta-linux.yml): HttpError: 404",
    ),
  ).toBe("v1.2.0-beta has no Linux update files yet; it may still be publishing.");
});

test("known updater failures get a short sentence", () => {
  expect(summarizeUpdateError("Error: net::ERR_INTERNET_DISCONNECTED")).toBe(
    "Could not reach GitHub.",
  );
  expect(summarizeUpdateError("No published versions on GitHub")).toBe(
    "No published release was found on GitHub.",
  );
  expect(summarizeUpdateError("Something: HttpError: 503 \nmore")).toBe(
    "GitHub answered HTTP 503.",
  );
});

test("an unknown error keeps its first line, bounded", () => {
  expect(summarizeUpdateError("offline")).toBe("offline");
  expect(summarizeUpdateError("first line\nsecond line")).toBe("first line");
  const summary = summarizeUpdateError("word ".repeat(100));
  expect(summary.length).toBeLessThanOrEqual(140);
  expect(summary.endsWith("…")).toBe(true);
});

test("details restore escaped newlines", () => {
  expect(updateErrorDetails(MISSING_MAC_FILE)).toContain("latest-mac.yml\n\nPlease double check");
});
