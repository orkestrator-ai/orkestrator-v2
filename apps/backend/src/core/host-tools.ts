import type { CommandContext } from "./commands-context.js";
import { resolveManagedBinary } from "./commands-agent-support.js";
import { commandExists } from "./shell.js";

type HostToolSource = "managed" | "path" | "missing";

const lastHostToolSourceByContext = new WeakMap<CommandContext, Map<string, HostToolSource>>();

function logHostToolAvailability(
  context: CommandContext,
  name: string,
  source: HostToolSource,
): void {
  let sources = lastHostToolSourceByContext.get(context);
  if (!sources) {
    sources = new Map();
    lastHostToolSourceByContext.set(context, sources);
  }
  if (sources.get(name) === source) return;
  sources.set(name, source);
  const message = `[Tooling] Host tool availability: tool=${name} available=${source !== "missing"} source=${source}`;
  if (source === "missing") console.warn(message);
  else console.info(message);
}

/**
 * Whether a host tool can run: the managed toolchain copy first, then PATH.
 */
export async function checkHostTool(context: CommandContext, name: string) {
  if (resolveManagedBinary(context, name)) {
    logHostToolAvailability(context, name, "managed");
    return true;
  }
  // An agent-test profile provisions its own toolchain. A host install on PATH
  // is a platform the profile never set up, and its login state is one the
  // isolated profile cannot see.
  if (context.runtimeFlavor === "agent-test") {
    logHostToolAvailability(context, name, "missing");
    return false;
  }
  const available = await commandExists(name);
  logHostToolAvailability(context, name, available ? "path" : "missing");
  return available;
}
