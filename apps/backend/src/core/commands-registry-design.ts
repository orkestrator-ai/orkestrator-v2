import { beginEnvironmentMutation } from "./environment-replacement-fence.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { registerDesignCommandHandlers } from "./design/index.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

/** Registers the design command surface (see `design/commands.ts`). */
export function registerDesignCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
) {
  registerDesignCommandHandlers(
    (name, handler) =>
      register(name, async (args, context) => {
        // Design commands can auto-export during reconciliation as well as an
        // explicit save. Hold admission before resolving their repository path.
        const id = typeof args.environmentId === "string" ? args.environmentId : undefined;
        const release = id ? beginEnvironmentMutation(id) : undefined;
        try {
          if (id && (await context.storage.getEnvironment(id))?.worktreeMove)
            throw new Error("Move recovery is pending. Restart Orkestrator before exporting.");
          return await handler(args, context);
        } finally {
          release?.();
        }
      }),
    { nativeSessionKey: nativeAgentSessionStorageKey },
  );
}
