import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  MCP_TRANSPORTS,
  type McpAdvancedFieldSchema,
  type McpFieldError,
  type McpTargetCapabilities,
  type McpTransport,
} from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { Switch } from "@/components/ui/switch";

import {
  advancedTextProblem,
  formatAdvancedValue,
  newArgRow,
  newMapRow,
  parseAdvancedText,
  removeMapRow,
  type MapRow,
  type McpDraft,
} from "./mcp-draft";

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: "Command (stdio)",
  http: "HTTP",
  sse: "SSE",
};

function FieldError({ errors, field }: { errors: McpFieldError[]; field: string }) {
  const messages = errors.filter(
    (error) => error.field === field || error.field.startsWith(`${field}.`),
  );
  if (!messages.length) return null;
  return (
    <p className="text-xs text-red-300" role="alert">
      {messages.map((error) => error.message).join(" ")}
    </p>
  );
}

function MapEditor({
  kind,
  label,
  draft,
  onChange,
  errors,
  secretHint,
}: {
  kind: "env" | "headers";
  label: string;
  draft: McpDraft;
  onChange: (draft: McpDraft) => void;
  errors: McpFieldError[];
  secretHint: string;
}) {
  const rows = draft[kind];
  const update = (id: string, patch: Partial<MapRow>) =>
    onChange({ ...draft, [kind]: rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <p className="text-xs text-muted-foreground">{secretHint}</p>
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Input
            aria-label={`${label} name ${index + 1}`}
            className="font-mono text-xs sm:w-44"
            value={row.key}
            onChange={(event) => update(row.id, { key: event.target.value })}
          />
          {row.mode === "keep" ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate rounded border border-white/10 px-2 py-1.5 text-xs text-muted-foreground">
                Value saved
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => update(row.id, { mode: "set", value: "" })}
              >
                Replace
              </Button>
            </div>
          ) : (
            <Input
              aria-label={`${label} value ${index + 1}`}
              className="min-w-0 flex-1 font-mono text-xs"
              type={row.originalReference !== undefined || kind === "env" ? "text" : "password"}
              autoComplete="off"
              placeholder={kind === "env" ? "value or ${VARIABLE}" : "value or Bearer ${TOKEN}"}
              value={row.value}
              onChange={(event) => update(row.id, { value: event.target.value })}
            />
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            aria-label={
              row.mode === "keep"
                ? `Clear saved ${label.toLowerCase()} ${row.key || index + 1}`
                : `Remove ${label.toLowerCase()} ${row.key || index + 1}`
            }
            onClick={() => onChange(removeMapRow(draft, kind, row.id))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs"
        onClick={() => onChange({ ...draft, [kind]: [...rows, newMapRow()] })}
      >
        <Plus className="h-3.5 w-3.5" /> Add {kind === "env" ? "variable" : "header"}
      </Button>
      <FieldError errors={errors} field={kind} />
    </fieldset>
  );
}

function AdvancedField({
  field,
  value,
  onChange,
}: {
  field: McpAdvancedFieldSchema;
  value: McpDraft["advanced"][string] | undefined;
  onChange: (value: McpDraft["advanced"][string]) => void;
}) {
  const id = `mcp-advanced-${field.id}`;
  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-xs">
          {field.label}
          {field.description ? (
            <span className="block font-normal text-muted-foreground">{field.description}</span>
          ) : null}
        </Label>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked ? true : "")}
        />
      </div>
    );
  }
  return <AdvancedTextField id={id} field={field} value={value} onChange={onChange} />;
}

/**
 * Number and list fields keep the typed text locally, so a trailing comma or
 * "1." stays on screen while the draft holds the parsed value. The text is
 * re-read from the draft only when the draft changes from elsewhere.
 */
function AdvancedTextField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: McpAdvancedFieldSchema;
  value: McpDraft["advanced"][string] | undefined;
  onChange: (value: McpDraft["advanced"][string]) => void;
}) {
  const [text, setText] = useState(() => formatAdvancedValue(value));
  const [synced, setSynced] = useState(value);
  if (!sameAdvancedValue(value, synced)) {
    setSynced(value);
    setText(formatAdvancedValue(value));
  }
  const edit = (next: string) => {
    const parsed = parseAdvancedText(field.type, next);
    setText(next);
    setSynced(parsed);
    onChange(parsed);
  };
  const problem = advancedTextProblem(field, text);
  const problemId = `${id}-problem`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {field.label}
      </Label>
      <Input
        id={id}
        className="font-mono text-xs"
        inputMode={field.type === "number" ? "decimal" : undefined}
        value={text}
        placeholder={field.type === "string-list" ? "comma-separated" : undefined}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        onChange={(event) => edit(event.target.value)}
        onBlur={() => {
          // Tidy list separators once the user leaves the field; numbers keep
          // their text so an invalid entry stays visible next to its message.
          if (field.type === "string-list") setText(formatAdvancedValue(synced));
        }}
      />
      {problem ? (
        <p id={problemId} className="text-xs text-red-300" role="alert">
          {problem}
        </p>
      ) : null}
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

function sameAdvancedValue(
  left: McpDraft["advanced"][string] | undefined,
  right: McpDraft["advanced"][string] | undefined,
): boolean {
  return JSON.stringify(left ?? "") === JSON.stringify(right ?? "");
}

export function McpServerForm({
  draft,
  onChange,
  capabilities,
  isNew,
  errors,
  projectScope,
  locationLabel,
  preservedFields,
}: {
  draft: McpDraft;
  onChange: (draft: McpDraft) => void;
  capabilities: McpTargetCapabilities;
  isNew: boolean;
  errors: McpFieldError[];
  projectScope: boolean;
  locationLabel: string;
  preservedFields: string[];
}) {
  const stdio = draft.transport === "stdio";
  const transports = MCP_TRANSPORTS.filter(
    (transport) => capabilities.transports[transport].supported || transport === draft.transport,
  );
  const secretHint = projectScope
    ? "Project files are shared through the repository: use a reference such as ${API_KEY}. Saved values stay hidden."
    : "Values are stored in the provider's own file with private permissions. Saved values are never shown.";
  const advanced = capabilities.fields.advanced.filter((field) =>
    field.transports.includes(draft.transport),
  );
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="mcp-server-name">Name</Label>
        <Input
          id="mcp-server-name"
          className="font-mono"
          value={draft.name}
          disabled={!isNew}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          aria-describedby="mcp-server-name-rule"
        />
        <p id="mcp-server-name-rule" className="text-xs text-muted-foreground">
          {isNew ? capabilities.nameRule.description : "Use Rename to change the name in one step."}
        </p>
        <FieldError errors={errors} field="name" />
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">Transport</span>
        <SegmentedSelector
          ariaLabel="Transport"
          value={draft.transport}
          options={transports.map((transport) => ({
            value: transport,
            label: TRANSPORT_LABEL[transport],
            disabled: !capabilities.transports[transport].supported,
          }))}
          onValueChange={(transport) => onChange({ ...draft, transport })}
        />
        {MCP_TRANSPORTS.filter((transport) => !capabilities.transports[transport].supported).map(
          (transport) => (
            <p key={transport} className="text-xs text-muted-foreground">
              {TRANSPORT_LABEL[transport]}: {capabilities.transports[transport].reason}
            </p>
          ),
        )}
        <FieldError errors={errors} field="transport" />
      </div>

      {stdio ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-server-command">Executable</Label>
            {draft.command.kind === "keep" ? (
              <div className="flex items-center gap-2">
                <span className="rounded border border-white/10 px-2 py-1.5 text-xs text-muted-foreground">
                  {draft.command.display}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => onChange({ ...draft, command: { kind: "set", value: "" } })}
                >
                  Replace
                </Button>
              </div>
            ) : (
              <Input
                id="mcp-server-command"
                className="font-mono text-xs"
                placeholder="npx"
                value={draft.command.value}
                onChange={(event) =>
                  onChange({ ...draft, command: { kind: "set", value: event.target.value } })
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              One program, not a shell command. It runs on {locationLabel.toLowerCase()} when a
              session loads the server.
            </p>
            <FieldError errors={errors} field="command" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Arguments</legend>
            {draft.args.map((arg, index) => (
              <div key={arg.id} className="flex items-center gap-2">
                {arg.kind === "keep" ? (
                  <span className="flex-1 rounded border border-white/10 px-2 py-1.5 text-xs text-muted-foreground">
                    {arg.display}
                  </span>
                ) : (
                  <Input
                    aria-label={`Argument ${index + 1}`}
                    className="flex-1 font-mono text-xs"
                    value={arg.value}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        args: draft.args.map((row) =>
                          row.id === arg.id
                            ? { ...row, kind: "set", value: event.target.value }
                            : row,
                        ) as McpDraft["args"],
                      })
                    }
                  />
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Remove argument ${index + 1}`}
                  onClick={() =>
                    onChange({ ...draft, args: draft.args.filter((row) => row.id !== arg.id) })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => onChange({ ...draft, args: [...draft.args, newArgRow()] })}
            >
              <Plus className="h-3.5 w-3.5" /> Add argument
            </Button>
            <p className="text-xs text-muted-foreground">
              Each row is passed as one argument; spaces and quotes are not interpreted.
            </p>
            <FieldError errors={errors} field="args" />
          </fieldset>
          {capabilities.fields.cwd.supported ? (
            <div className="space-y-1.5">
              <Label htmlFor="mcp-server-cwd">Working directory (optional)</Label>
              <Input
                id="mcp-server-cwd"
                className="font-mono text-xs"
                value={draft.cwd}
                onChange={(event) => onChange({ ...draft, cwd: event.target.value })}
              />
              <FieldError errors={errors} field="cwd" />
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="mcp-server-url">URL</Label>
          {draft.url.kind === "keep" ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate rounded border border-white/10 px-2 py-1.5 font-mono text-xs text-muted-foreground">
                {draft.url.display}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => onChange({ ...draft, url: { kind: "set", value: "" } })}
              >
                Replace
              </Button>
            </div>
          ) : (
            <Input
              id="mcp-server-url"
              className="font-mono text-xs"
              placeholder="https://example.com/mcp"
              value={draft.url.value}
              onChange={(event) =>
                onChange({ ...draft, url: { kind: "set", value: event.target.value } })
              }
            />
          )}
          <p className="text-xs text-muted-foreground">
            Resolved from {locationLabel.toLowerCase()}, not from this browser.
          </p>
          <FieldError errors={errors} field="url" />
        </div>
      )}

      <MapEditor
        kind="env"
        label="Environment variables"
        draft={draft}
        onChange={onChange}
        errors={errors}
        secretHint={secretHint}
      />
      {!stdio ? (
        <MapEditor
          kind="headers"
          label="Headers"
          draft={draft}
          onChange={onChange}
          errors={errors}
          secretHint={secretHint}
        />
      ) : null}

      {capabilities.operations.setEnabled.supported && isNew ? (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="mcp-server-enabled">Enabled</Label>
          <Switch
            id="mcp-server-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
        </div>
      ) : null}

      {advanced.length ? (
        <details className="rounded-md border border-white/10 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">Advanced</summary>
          <div className="mt-3 space-y-3">
            {advanced.map((field) => (
              <AdvancedField
                key={field.id}
                field={field}
                value={draft.advanced[field.id]}
                onChange={(value) =>
                  onChange({ ...draft, advanced: { ...draft.advanced, [field.id]: value } })
                }
              />
            ))}
            <FieldError errors={errors} field="advanced" />
          </div>
        </details>
      ) : null}

      {preservedFields.length ? (
        <p className="text-xs text-muted-foreground">
          Kept as they are: {preservedFields.join(", ")}. This form does not edit these settings.
        </p>
      ) : null}
      <FieldError errors={errors} field="definition" />
    </div>
  );
}
