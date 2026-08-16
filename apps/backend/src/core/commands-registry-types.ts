import type { CommandHandler } from "./commands-context.js";

export type CommandRegistrar = (name: string, handler: CommandHandler) => void;

export type RegistryDependencies = {
  [key: string]: any;
};

