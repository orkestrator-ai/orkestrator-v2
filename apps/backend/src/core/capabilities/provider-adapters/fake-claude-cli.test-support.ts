/**
 * A stand-in for the Claude 2.1.326 plugin CLI over real directories, for
 * tests. It mirrors the behaviour observed on the pinned binary: a
 * directory marketplace is read in place (`readFromFolder` follows the
 * current `marketplace.json`), `install` copies the plugin into
 * `<config>/plugins/cache/<marketplace>/<name>/<version>`, and the version is
 * the manifest's, so an unchanged version is not re-copied by `update`.
 *
 * Faults can be injected per subcommand: the command can time out or exit
 * non-zero before or after doing its work, so the adapter's read-back is
 * what decides the outcome.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ClaudeCliResult, ClaudePluginCli } from "./claude-plugins.js";

type Fault = "timeout-before" | "timeout-after" | "exit-after";

interface Installed {
  marketplace: string;
  name: string;
  enabled: boolean;
  installPath: string;
}

export class FakeClaudeCli {
  readonly calls: string[][] = [];
  readonly marketplaces = new Map<string, string>();
  readonly installed = new Map<string, Installed>();
  private readonly faults = new Map<string, Fault>();

  constructor(private readonly configDir: string) {}

  /** The next run of `plugin <subcommand>` (or `plugin marketplace <subcommand>`) misbehaves. */
  fail(subcommand: string, fault: Fault): void {
    this.faults.set(subcommand, fault);
  }

  count(subcommand: string): number {
    return this.calls.filter((args) => commandOf(args) === subcommand).length;
  }

  readonly cli: ClaudePluginCli = async (args) => {
    this.calls.push([...args]);
    const command = commandOf(args);
    const fault = this.faults.get(command);
    this.faults.delete(command);
    if (fault === "timeout-before") return { stdout: "", exitCode: null, timedOut: true };
    const result = await this.run(command, args);
    if (fault === "timeout-after") return { stdout: "", exitCode: null, timedOut: true };
    if (fault === "exit-after") return { stdout: '{"message":"interrupted"}', exitCode: 1 };
    return result;
  };

  private async marketplaceEntries(
    marketplace: string,
  ): Promise<Array<{ name: string; source: string; version?: string }>> {
    const root = this.marketplaces.get(marketplace);
    if (!root) return [];
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"),
      ) as { plugins?: Array<{ name: string; source: string; version?: string }> };
      return value.plugins ?? [];
    } catch {
      return [];
    }
  }

  private async folderOf(marketplace: string, name: string): Promise<string | undefined> {
    const entry = (await this.marketplaceEntries(marketplace)).find((item) => item.name === name);
    const root = this.marketplaces.get(marketplace);
    return entry && root ? path.resolve(root, entry.source) : undefined;
  }

  private async run(command: string, args: string[]): Promise<ClaudeCliResult> {
    const ok = (value: unknown): ClaudeCliResult => ({
      stdout: JSON.stringify(value),
      exitCode: 0,
    });
    const fail = (message: string): ClaudeCliResult => ({
      stdout: JSON.stringify({ outcome: "error", message }),
      exitCode: 1,
    });
    switch (command) {
      case "marketplace list":
        return ok(
          [...this.marketplaces].map(([name, root]) => ({
            name,
            source: "directory",
            path: root,
            installLocation: root,
          })),
        );
      case "marketplace add": {
        const root = path.resolve(args[3]!);
        let name: string;
        try {
          name = (
            JSON.parse(
              await fs.readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"),
            ) as { name: string }
          ).name;
        } catch {
          return fail("No marketplace.json");
        }
        if (this.marketplaces.has(name)) return fail(`Marketplace ${name} already exists`);
        this.marketplaces.set(name, root);
        return ok({ outcome: "ok", marketplace: name });
      }
      case "marketplace remove":
        this.marketplaces.delete(args[3]!);
        return ok({ outcome: "ok" });
      case "list": {
        const list = [];
        for (const [id, entry] of this.installed) {
          const folder = await this.folderOf(entry.marketplace, entry.name);
          list.push({
            id,
            version: path.basename(entry.installPath),
            scope: "user",
            enabled: entry.enabled,
            installPath: entry.installPath,
            ...(folder ? { readFromFolder: folder } : {}),
          });
        }
        return ok(list);
      }
      case "install": {
        const id = args[2]!;
        const [name, marketplace] = id.split("@") as [string, string];
        const folder = await this.folderOf(marketplace, name);
        if (!folder) return fail(`Plugin ${id} not found`);
        let version = "unknown";
        try {
          version =
            (
              JSON.parse(
                await fs.readFile(path.join(folder, ".claude-plugin", "plugin.json"), "utf8"),
              ) as { version?: string }
            ).version ?? "unknown";
        } catch {
          return fail("Invalid plugin manifest");
        }
        const installPath = path.join(
          this.configDir,
          "plugins",
          "cache",
          marketplace,
          name,
          version,
        );
        await fs.rm(installPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(installPath), { recursive: true });
        await fs.cp(folder, installPath, { recursive: true });
        this.installed.set(id, { marketplace, name, enabled: true, installPath });
        return ok({ outcome: "ok", pluginId: id });
      }
      case "uninstall": {
        const id = args[2]!;
        const entry = this.installed.get(id);
        if (!entry) return fail(`Plugin ${id} is not installed`);
        await fs.rm(entry.installPath, { recursive: true, force: true });
        this.installed.delete(id);
        return ok({ outcome: "ok", pluginId: id });
      }
      case "enable":
      case "disable": {
        const entry = this.installed.get(args[2]!);
        if (!entry) return fail("Not installed");
        entry.enabled = command === "enable";
        return ok({ outcome: "ok" });
      }
      default:
        return fail(`Unexpected command ${args.join(" ")}`);
    }
  }
}

function commandOf(args: readonly string[]): string {
  return args[1] === "marketplace" ? `marketplace ${args[2]}` : (args[1] ?? "");
}
