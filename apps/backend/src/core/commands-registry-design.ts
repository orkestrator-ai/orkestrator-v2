import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { wrapRegistrar } from "./commands-registry-contracts.js";
import { registerDefinedDesignCommands } from "./design/index.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

/** Registers the design command surface with its definitions (see `design/commands.ts`). */
export function registerDesignCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
) {
  registerDefinedDesignCommands(designAdmissionRegistrar(register), {
    nativeSessionKey: nativeAgentSessionStorageKey,
  });
}

/**
 * Design commands can auto-export during reconciliation as well as an explicit
 * save, so each holds environment admission before resolving its repository
 * path. Forwards both registration forms.
 */
export function designAdmissionRegistrar(register: CommandRegistrar): CommandRegistrar {
  return wrapRegistrar(register, (_name, handler) => async (args, context, invocation) => {
    const id = typeof args.environmentId === "string" ? args.environmentId : undefined;
    const release = id ? context.runtime.environments.fence.beginMutation(id) : undefined;
    try {
      if (id && (await context.storage.getEnvironment(id))?.worktreeMove)
        throw new Error("Move recovery is pending. Restart Orkestrator before exporting.");
      return await handler(args, context, invocation);
    } finally {
      release?.();
    }
  });
}
