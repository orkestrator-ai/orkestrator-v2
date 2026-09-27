import {
  PUBLIC_ENVIRONMENT_SETTINGS,
  PUBLIC_PROJECT_SETTINGS,
  type PublicSettingDescriptor,
  type PublicSettingsChange,
  type PublicSettingsSnapshot,
} from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { CliError } from "../errors.js";
import { settingsLines, table } from "../format.js";
import { readPatch } from "../inputs.js";
import type { CommandSpec } from "../spec.js";
import { REQUEST_ID_OPTION, submit } from "./common.js";

/**
 * `<scope> config get|set|unset`. Values given with `--set key=value` are
 * parsed as JSON when they parse (numbers, booleans, arrays), otherwise taken
 * as strings. A patch file holds `{"set": {...}, "unset": [...]}`. Nothing is
 * read-modify-written on the client: the backend applies the patch atomically
 * under the revision check.
 */

function parseAssignment(raw: string): [string, unknown] {
  const equals = raw.indexOf("=");
  if (equals <= 0) throw new CliError("invalid-input", "--set expects KEY=VALUE");
  const key = raw.slice(0, equals);
  const text = raw.slice(equals + 1);
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Plain strings need no quoting on the command line.
  }
  return [key, value];
}

function descriptors(scope: "project" | "environment"): readonly PublicSettingDescriptor[] {
  return scope === "project" ? PUBLIC_PROJECT_SETTINGS : PUBLIC_ENVIRONMENT_SETTINGS;
}

export function settingsCommands(scope: "project" | "environment"): CommandSpec[] {
  const idName = scope === "project" ? "project" : "environment";
  const idKey = scope === "project" ? "projectId" : "environmentId";
  const keysHelp = descriptors(scope)
    .map((descriptor) => `  ${descriptor.key} (${descriptor.type}; ${descriptor.application})`)
    .join("\n");
  const applies =
    scope === "environment"
      ? "Changing defaults here never reconfigures a live conversation; use `session config set` for that."
      : "Repository settings apply to environments created afterwards unless noted.";
  return [
    {
      path: [scope, "config", "get"],
      summary: `Show ${scope} settings with effective values, sources and application timing.`,
      positionals: [{ name: idName, required: true }],
      options: [],
      async run(context, parsed) {
        const session = await context.session();
        const snapshot = await session.read<PublicSettingsSnapshot>(`${scope}.config.get`, {
          [idKey]: parsed.positionals[idName],
        });
        return {
          action: `${scope}.config.get`,
          result: snapshot,
          connection: session.identity,
          human: settingsLines(snapshot),
        };
      },
    },
    {
      path: [scope, "config", "set"],
      summary: `Set and/or unset ${scope} settings atomically.`,
      description: `Settable keys:\n${keysHelp}\n${applies}`,
      positionals: [{ name: idName, required: true }],
      options: [
        {
          name: "set",
          kind: "list",
          valueName: "KEY=VALUE",
          description: "Set a key (repeatable).",
        },
        {
          name: "unset",
          kind: "list",
          valueName: "KEY",
          description: "Unset a key, restoring inheritance (repeatable).",
        },
        {
          name: "patch-file",
          kind: "string",
          valueName: "PATH",
          description: 'Local JSON file: {"set": {...}, "unset": [...]}.',
        },
        { name: "patch-stdin", kind: "boolean", description: "Read the JSON patch from stdin." },
        {
          name: "expected-revision",
          kind: "string",
          valueName: "REV",
          description: "Conflict unless the settings are still at this revision.",
        },
        REQUEST_ID_OPTION,
      ],
      async run(context, parsed) {
        const options = parsed.options;
        const set: Record<string, unknown> = {};
        const unset: string[] = [];
        const patch = await readPatch(context.io, options);
        const hasFlags =
          (options.set as unknown[] | undefined)?.length ||
          (options.unset as unknown[] | undefined)?.length;
        if (patch && hasFlags) {
          throw new CliError("invalid-input", "Use either a patch file or --set/--unset, not both");
        }
        if (patch) {
          for (const key of Object.keys(patch)) {
            if (key !== "set" && key !== "unset") {
              throw new CliError("invalid-input", "A patch may contain only `set` and `unset`");
            }
          }
          if (patch.set !== undefined) {
            if (!patch.set || typeof patch.set !== "object" || Array.isArray(patch.set)) {
              throw new CliError("invalid-input", "Patch `set` must be an object");
            }
            Object.assign(set, patch.set);
          }
          if (patch.unset !== undefined) {
            if (
              !Array.isArray(patch.unset) ||
              !patch.unset.every((key) => typeof key === "string")
            ) {
              throw new CliError("invalid-input", "Patch `unset` must be an array of keys");
            }
            unset.push(...(patch.unset as string[]));
          }
        }
        for (const raw of (options.set as string[] | undefined) ?? []) {
          const [key, value] = parseAssignment(raw);
          if (Object.hasOwn(set, key)) {
            throw new CliError("invalid-input", `Setting ${key} was given more than once`);
          }
          set[key] = value;
        }
        unset.push(...((options.unset as string[] | undefined) ?? []));
        if (Object.keys(set).length === 0 && unset.length === 0) {
          throw new CliError("invalid-input", "Nothing to change; pass --set, --unset or a patch");
        }
        if (Object.keys(set).length + unset.length > PUBLIC_API_LIMITS.patchMaxFields) {
          throw new CliError("input-too-large", "Too many settings in one change");
        }
        const { session, result, receipt, warnings } = await submit<{
          settings: PublicSettingsSnapshot;
          changes: PublicSettingsChange[];
        }>(
          context,
          `${scope}.config.set`,
          {
            [idKey]: parsed.positionals[idName],
            set,
            unset,
            ...(options["expected-revision"] !== undefined
              ? { expectedRevision: options["expected-revision"] }
              : {}),
          },
          options,
        );
        return {
          action: `${scope}.config.set`,
          result,
          receipt,
          warnings,
          connection: session.identity,
          human: [
            ...table(
              ["KEY", "CHANGE", "APPLIES"],
              result.changes.map((change) => [change.key, change.change, change.application]),
            ),
            "",
            ...settingsLines(result.settings),
          ],
        };
      },
    },
    {
      path: [scope, "config", "unset"],
      summary: `Unset ${scope} settings, restoring inheritance.`,
      positionals: [
        { name: idName, required: true },
        { name: "key", required: true, variadic: true },
      ],
      options: [
        {
          name: "expected-revision",
          kind: "string",
          valueName: "REV",
          description: "Conflict unless the settings are still at this revision.",
        },
        REQUEST_ID_OPTION,
      ],
      async run(context, parsed) {
        const keys = parsed.positionals.key as string[];
        const { session, result, receipt, warnings } = await submit<{
          settings: PublicSettingsSnapshot;
          changes: PublicSettingsChange[];
        }>(
          context,
          `${scope}.config.set`,
          {
            [idKey]: parsed.positionals[idName],
            set: {},
            unset: keys,
            ...(parsed.options["expected-revision"] !== undefined
              ? { expectedRevision: parsed.options["expected-revision"] }
              : {}),
          },
          parsed.options,
        );
        return {
          action: `${scope}.config.set`,
          result,
          receipt,
          warnings,
          connection: session.identity,
          human: settingsLines(result.settings),
        };
      },
    },
  ];
}
