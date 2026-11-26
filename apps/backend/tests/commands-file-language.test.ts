import { registrarFrom } from "../src/core/commands/registry-contracts.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { CommandContext, CommandHandler } from "../src/core/commands/context";
import * as helpers from "../src/core/commands/helpers";
import { registerTerminalCommands } from "../src/core/commands/registry-terminal";
import type { RegistryDependencies } from "../src/core/commands/registry-types";

const commands = new Map<string, CommandHandler>();
// File reads use no registry collaborators or context; call their real handlers
// directly, replacing only the Docker transport (no daemon or shell needed).
registerTerminalCommands(
  registrarFrom((name, handler) => commands.set(name, handler)),
  {} as RegistryDependencies,
);
afterEach(() => transport?.mockRestore());
let transport: ReturnType<typeof spyOn<typeof helpers, "dockerExec">> | undefined;

for (const filePath of ["src/app.ts", ".env", ".env.local", "config/production.env"]) {
  test(`read_container_file normalizes the language for ${filePath}`, async () => {
    const content = "EXAMPLE=value\n";
    transport = spyOn(helpers, "dockerExec").mockImplementation(async () =>
      Buffer.from(content).toString("base64"),
    );
    const handler = commands.get("read_container_file")!;
    expect(
      await handler({ containerId: "fixture-container", filePath }, {} as CommandContext),
    ).toEqual({
      path: filePath,
      content,
      language: filePath.endsWith(".ts") ? "typescript" : "dotenv",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
}
