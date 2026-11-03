import { expect, test } from "bun:test";
import { neutralizeGitFilters } from "./git-filter-config.js";
import { CommandFailedError } from "./shell.js";

test("filter configuration handles dotted names, all settings and duplicate keys", async () => {
  const args = await neutralizeGitFilters(
    async () =>
      "filter.evil.dotted.clean\nprogram\nwith newline\0filter.evil.dotted.process\nother\0filter.only.required\ntrue\0",
  );
  expect(args).toEqual(
    ["evil.dotted", "only"].flatMap((name) =>
      ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => [
        "-c",
        `filter.${name}.${setting}`,
      ]),
    ),
  );
});

test("only no-matching-key exit 1 permits a scan without filter overrides", async () => {
  expect(
    await neutralizeGitFilters(async () => {
      throw new CommandFailedError("no match", { exitCode: 1 });
    }),
  ).toEqual([]);
  for (const error of [
    new CommandFailedError("invalid config", { exitCode: 128 }),
    new CommandFailedError("timeout", { timedOut: true }),
    new Error("read failed"),
  ]) {
    await expect(
      neutralizeGitFilters(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  }
});
