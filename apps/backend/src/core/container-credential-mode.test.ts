import { expect, test } from "bun:test";
import { containerCredentialMode } from "./container-credential-mode.js";
import type { CommandContext } from "./commands-context.js";
const context = {} as CommandContext;
test.each(["supported", "unsupported"] as const)("known %s capability", async (support) => {
  expect(await containerCredentialMode(context, "container", async () => support)).toBe(
    support === "supported" ? "verifier" : "token-file",
  );
});
test("unknown and failed reads refuse a downgrade", async () => {
  for (const check of [
    async () => "unknown" as const,
    async (): Promise<never> => {
      throw new Error("unavailable");
    },
  ]) {
    await expect(containerCredentialMode(context, "container", check)).rejects.toThrow(
      "Cannot determine bridge credential support",
    );
  }
});
