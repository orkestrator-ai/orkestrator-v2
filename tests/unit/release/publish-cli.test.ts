import { expect, test } from "bun:test";
import { cliPublishCommand } from "../../../scripts/publish-cli";

test.each([
  ["2.23.0", "latest"],
  ["2.23.0-beta", "beta"],
  ["2.23.0-beta.2", "beta"],
  ["2.24.0-alpha", "alpha"],
  ["2.24.0-alpha.12", "alpha"],
])("publishes %s under the %s dist-tag", (version, distTag) => {
  expect(cliPublishCommand(version)).toEqual([
    "bun",
    "publish",
    "--cwd",
    "packages/cli",
    "--access",
    "public",
    "--tag",
    distTag,
  ]);
});

test.each(["2.23.0-rc.1", "2.23.0-canary.1", "garbage"])(
  "refuses %s before a publish command exists",
  (version) => {
    expect(() => cliPublishCommand(version)).toThrow("no update channel ships");
  },
);
