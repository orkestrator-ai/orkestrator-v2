import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { registerDesignCommandHandlers } from "./design-commands.js";

/** Registers the design command surface (see `design-commands.ts`). */
export function registerDesignCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
) {
  registerDesignCommandHandlers((name, handler) =>
    register(name, (args, context) => handler(args, context)),
  );
}
