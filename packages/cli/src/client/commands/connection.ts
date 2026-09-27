import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { BACKEND_INSTANCE_DESCRIPTOR_FILE } from "@orkestrator/protocol/backend-instance";
import type { PublicCapabilities } from "@orkestrator/protocol/public-api";
import { assertConnectionName, CliConfigStore, type SavedConnection } from "../config.js";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { LocalReceiptStore } from "../receipts.js";
import { ClientSession } from "../session.js";
import type { CommandContext, CommandSpec } from "../spec.js";
import {
  normalizeBaseUrl,
  readDescriptor,
  readTokenFile,
  redactEndpoint,
  resolveSavedConnection,
  resolveTarget,
  type ResolvedTarget,
} from "../targets.js";
import { stringOption } from "./common.js";

function store(context: CommandContext): CliConfigStore {
  return context.configStore;
}

async function removeManagedCredential(
  configStore: CliConfigStore,
  name: string,
  saved: SavedConnection | undefined,
): Promise<void> {
  if (saved?.kind !== "endpoint") return;
  const legacyFile = path.join(configStore.credentialsDirectory, `${name}.json`);
  if (saved.managedCredential !== true && saved.credentialFile !== legacyFile) return;
  await configStore.removeOwnedCredential(saved.credentialFile).catch(() => undefined);
}

function describeSaved(name: string, saved: SavedConnection, isDefault: boolean) {
  return {
    name,
    kind: saved.kind,
    default: isDefault,
    ...(saved.kind === "descriptor"
      ? { descriptorPath: saved.descriptorPath }
      : { endpoint: redactEndpoint(saved.url), credentialFile: saved.credentialFile }),
    installationId: saved.installationId ?? null,
    addedAt: saved.addedAt,
  };
}

function capabilitySummary(capabilities: PublicCapabilities) {
  const actions = Object.entries(capabilities.actions);
  return {
    installationId: capabilities.backend.installationId,
    generation: capabilities.backend.generation,
    version: capabilities.backend.version,
    startedAt: capabilities.backend.startedAt,
    availableActions: actions.filter(([, entry]) => entry.available).map(([name]) => name),
    unavailableActions: actions
      .filter(([, entry]) => !entry.available)
      .map(([name, entry]) => ({ name, reason: entry.reason ?? null })),
    currentNamespace: capabilities.requestKeys.currentNamespace,
    providers: capabilities.providers,
    features: capabilities.features,
  };
}

async function checkTarget(context: CommandContext, target: ResolvedTarget) {
  const session = new ClientSession(
    target,
    new LocalReceiptStore(store(context).receiptsDirectory),
    {
      requestTimeoutMs: context.global.requestTimeoutMs,
      signal: context.signal,
    },
  );
  const capabilities = await session.capabilities();
  return { session, capabilities };
}

export const connectionCommands: CommandSpec[] = [
  {
    path: ["connection", "list"],
    summary: "List saved connections (credentials are never shown).",
    positionals: [],
    options: [],
    local: true,
    idOutput: "connection name",
    async run(context) {
      const config = await store(context).read();
      const connections = Object.entries(config.connections).map(([name, saved]) =>
        describeSaved(name, saved, config.defaultConnection === name),
      );
      return {
        action: "connection.list",
        result: { connections, defaultConnection: config.defaultConnection ?? null },
        ids: connections.map((connection) => connection.name),
        human: table(
          ["NAME", "KIND", "DEFAULT", "TARGET"],
          connections.map((connection) => [
            connection.name,
            connection.kind,
            connection.default ? "yes" : "",
            "descriptorPath" in connection
              ? String(connection.descriptorPath)
              : String(connection.endpoint),
          ]),
        ),
      };
    },
  },
  {
    path: ["connection", "show"],
    summary: "Show one saved connection.",
    positionals: [{ name: "name", required: true }],
    options: [],
    local: true,
    async run(context, parsed) {
      const name = String(parsed.positionals.name);
      const config = await store(context).read();
      const saved = config.connections[name];
      if (!saved) throw new CliError("not-found", `No saved connection named '${name}'`);
      const described = describeSaved(name, saved, config.defaultConnection === name);
      return {
        action: "connection.show",
        result: described,
        human: keyValues(Object.entries(described)),
      };
    },
  },
  {
    path: ["connection", "add"],
    summary: "Save a named connection to a running backend.",
    description:
      "Use --data-dir (or --descriptor) for a backend on this machine: the client reads the backend's published instance descriptor and its private auth file on each call. Use --url with --credential-file or --token-stdin for a remote backend; tokens are never accepted as arguments. The backend is contacted and its installation identity is pinned unless --no-check is given.",
    positionals: [{ name: "name", required: true }],
    options: [
      {
        name: "data-dir",
        kind: "string",
        valueName: "DIR",
        description: "Backend data directory on this machine.",
      },
      {
        name: "descriptor",
        kind: "string",
        valueName: "PATH",
        description: `Path of a backend's ${BACKEND_INSTANCE_DESCRIPTOR_FILE}.`,
      },
      {
        name: "url",
        kind: "string",
        valueName: "URL",
        description: "Remote gateway URL (https, or http on loopback/Tailscale).",
      },
      {
        name: "credential-file",
        kind: "string",
        valueName: "PATH",
        description: "Private (chmod 600) file holding the gateway token.",
      },
      {
        name: "token-stdin",
        kind: "boolean",
        description: "Read the gateway token from stdin and store it privately.",
      },
      { name: "default", kind: "boolean", description: "Also make this the default connection." },
      {
        name: "check",
        kind: "boolean",
        negatable: true,
        description: "Contact the backend and pin its identity (default on).",
      },
      {
        name: "replace",
        kind: "boolean",
        description: "Replace an existing connection with the same name.",
      },
    ],
    local: true,
    async run(context, parsed) {
      const name = String(parsed.positionals.name);
      assertConnectionName(name);
      const options = parsed.options;
      const configStore = store(context);
      const config = await configStore.read();
      if (config.connections[name] && options.replace !== true) {
        throw new CliError(
          "conflict",
          `A connection named '${name}' already exists; pass --replace`,
        );
      }
      const dataDir = stringOption(options, "data-dir");
      const descriptorOption = stringOption(options, "descriptor");
      const url = stringOption(options, "url");
      const credentialFile = stringOption(options, "credential-file");
      const tokenStdin = options["token-stdin"] === true;
      const modes = [dataDir || descriptorOption ? "local" : null, url ? "remote" : null].filter(
        Boolean,
      );
      if (modes.length !== 1 || (dataDir && descriptorOption)) {
        throw new CliError(
          "invalid-input",
          "Pass exactly one of --data-dir, --descriptor, or --url",
        );
      }
      const now = new Date().toISOString();
      let saved: SavedConnection;
      let newCredential: string | undefined;
      if (url) {
        if ((credentialFile ? 1 : 0) + (tokenStdin ? 1 : 0) !== 1) {
          throw new CliError(
            "invalid-input",
            "A --url connection needs exactly one of --credential-file or --token-stdin",
          );
        }
        const normalizedUrl = normalizeBaseUrl(url);
        let file: string;
        if (credentialFile) {
          file = path.resolve(context.io.cwd, credentialFile);
          await readTokenFile(file, true);
        } else {
          const bytes = await context.io.readStdin(16 * 1024);
          const token = new TextDecoder().decode(bytes).trim();
          if (token.length < 16 || token.length > 1024 || /\s/.test(token)) {
            throw new CliError(
              "invalid-input",
              "The token read from stdin is not a valid gateway token",
            );
          }
          file = await configStore.storeCredential(`${name}.${randomUUID()}`, token);
          newCredential = file;
        }
        saved = {
          kind: "endpoint",
          url: normalizedUrl,
          credentialFile: file,
          ...(newCredential ? { managedCredential: true } : {}),
          addedAt: now,
        };
      } else {
        const descriptorPath = path.resolve(
          context.io.cwd,
          descriptorOption ?? path.join(dataDir!, BACKEND_INSTANCE_DESCRIPTOR_FILE),
        );
        saved = { kind: "descriptor", descriptorPath, addedAt: now };
      }
      let checked: Awaited<ReturnType<typeof checkTarget>> | null = null;
      const previous = config.connections[name];
      try {
        if (options.check !== false) {
          if (saved.kind === "descriptor") await readDescriptor(saved.descriptorPath);
          checked = await checkTarget(context, await resolveSavedConnection(name, saved));
          saved = { ...saved, installationId: checked.capabilities.backend.installationId };
        }
        config.connections[name] = saved;
        if (options.default === true) config.defaultConnection = name;
        await configStore.write(config);
      } catch (error) {
        if (newCredential) await fs.rm(newCredential, { force: true }).catch(() => undefined);
        throw error;
      }
      await removeManagedCredential(configStore, name, previous);
      const described = describeSaved(name, saved, config.defaultConnection === name);
      return {
        action: "connection.add",
        result: { connection: described, verified: checked !== null },
        ...(checked ? { connection: checked.session.identity } : {}),
        human: [
          `saved connection '${name}'${checked ? ` (installation ${saved.installationId})` : " (not verified)"}`,
        ],
      };
    },
  },
  {
    path: ["connection", "check"],
    summary: "Verify the selected backend's identity and list its capabilities.",
    description:
      "Checks the connection named here, or else the one selected with --connection/--profile/default. Exits 4 when unreachable or when the installation identity does not match the saved one.",
    positionals: [{ name: "name", required: false }],
    options: [],
    local: true,
    async run(context, parsed) {
      const name = parsed.positionals.name as string | undefined;
      if (name && (context.global.connection || context.global.profile)) {
        throw new CliError(
          "invalid-input",
          "Pass the connection name or a global selector, not both",
        );
      }
      const target = await resolveTarget(
        name
          ? { connection: name }
          : { connection: context.global.connection, profile: context.global.profile },
        store(context),
        context.io.env,
      );
      const { session, capabilities } = await checkTarget(context, target);
      const summary = capabilitySummary(capabilities);
      return {
        action: "connection.check",
        result: { connection: session.identity, capabilities: summary },
        connection: session.identity,
        human: keyValues([
          ["connection", `${session.identity.kind} ${session.identity.name}`],
          ["endpoint", session.identity.endpoint],
          ["installation", summary.installationId],
          ["generation", summary.generation],
          ["version", summary.version],
          ["actions", `${summary.availableActions.length} available`],
          ["namespace", summary.currentNamespace],
        ]),
      };
    },
  },
  {
    path: ["connection", "default"],
    summary: "Set (or --clear) the default connection.",
    positionals: [{ name: "name", required: false }],
    options: [{ name: "clear", kind: "boolean", description: "Remove the default." }],
    local: true,
    async run(context, parsed) {
      const name = parsed.positionals.name as string | undefined;
      const clear = parsed.options.clear === true;
      if ((name ? 1 : 0) + (clear ? 1 : 0) !== 1) {
        throw new CliError("invalid-input", "Pass a connection name or --clear");
      }
      const configStore = store(context);
      const config = await configStore.read();
      if (name && !config.connections[name]) {
        throw new CliError("not-found", `No saved connection named '${name}'`);
      }
      if (clear) delete config.defaultConnection;
      else config.defaultConnection = name;
      await configStore.write(config);
      return {
        action: "connection.default",
        result: { defaultConnection: config.defaultConnection ?? null },
        human: [clear ? "default connection cleared" : `default connection is '${name}'`],
      };
    },
  },
  {
    path: ["connection", "remove"],
    summary: "Forget a saved connection (the backend is not affected).",
    positionals: [{ name: "name", required: true }],
    options: [],
    local: true,
    async run(context, parsed) {
      const name = String(parsed.positionals.name);
      const configStore = store(context);
      const config = await configStore.read();
      if (!config.connections[name])
        throw new CliError("not-found", `No saved connection named '${name}'`);
      const previous = config.connections[name];
      delete config.connections[name];
      if (config.defaultConnection === name) delete config.defaultConnection;
      await configStore.write(config);
      await removeManagedCredential(configStore, name, previous);
      return {
        action: "connection.remove",
        result: { removed: name },
        human: [`removed '${name}'`],
      };
    },
  },
];
