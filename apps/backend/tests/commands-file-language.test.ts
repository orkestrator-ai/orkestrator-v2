import { afterEach, expect, spyOn, test } from "bun:test";
import type { CommandContext, CommandHandler } from "../src/core/commands-context";
import * as helpers from "../src/core/commands-helpers";
import { registerTerminalCommands } from "../src/core/commands-registry-terminal";
import type { RegistryDependencies } from "../src/core/commands-registry-types";

const commands = new Map<string, CommandHandler>();
// File reads use no registry collaborators or context; call their real handlers
// directly, replacing only the Docker transport (no daemon or shell needed).
registerTerminalCommands(
  (name, handler) => commands.set(name, handler),
  {} as RegistryDependencies,
);
afterEach(() => transport?.mockRestore());
let transport: ReturnType<typeof spyOn<typeof helpers, "dockerExec">> | undefined;

for (const filePath of ["src/app.ts", ".env", ".env.local", "config/production.env"]) {
  for (const command of ["read_container_file", "read_file_at_branch"]) {
    test(`${command} normalizes the language for ${filePath}`, async () => {
      const content = "EXAMPLE=value\n";
      transport = spyOn(helpers, "dockerExec").mockImplementation(async (_id, script) =>
        script.startsWith("git cat-file")
          ? String(Buffer.byteLength(content))
          : Buffer.from(content).toString("base64"),
      );
      const handler = commands.get(command)!;
      expect(
        await handler(
          { containerId: "fixture-container", filePath, branch: "main" },
          {} as CommandContext,
        ),
      ).toEqual({
        path: filePath,
        content,
        language: filePath.endsWith(".ts") ? "typescript" : "dotenv",
      });
      expect(transport).toHaveBeenCalledTimes(command === "read_file_at_branch" ? 2 : 1);
    });
  }
}
