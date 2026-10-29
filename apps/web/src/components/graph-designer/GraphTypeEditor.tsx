import { useId, useState } from "react";
import { Wand2 } from "lucide-react";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import type {
  ArtifactTypeDef,
  ArtifactTypeRender,
} from "@orkestrator/protocol/graphs/artifact-type-def";
import {
  GRAPH_TEMPLATE_BOUNDS,
  isGraphFieldPath,
  isGraphId,
} from "@orkestrator/protocol/graphs/grammar";
import { draftGraphSchemaFromExample } from "@orkestrator/protocol/graphs/schema-from-example";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { isGraphBuiltInTypeName } from "@orkestrator/protocol/graphs/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GraphSchemaEditor } from "./GraphSchemaEditor";
import {
  blankGraphCustomType,
  graphCustomTypeIssues,
  graphSchemaArrayPaths,
  graphSchemaFieldPaths,
  graphTypeRef,
  graphTypeUses,
  renameGraphTypeRef,
} from "./graph-designer-types";
import { useGraphEditor } from "./graph-editor-context";
import {
  AddButton,
  CommitField,
  EntryCard,
  FIELD_CLASS,
  FormSection,
  JsonField,
  NumberField,
  RemoveButton,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * The template's custom types (item 212, report §5.3, §5.12): add, remove
 * and edit them. A type's schema is edited with the subset form editor, or
 * drafted from its example ("Schema from example", item 102). Renaming a type
 * or changing its major version rewrites every port that names it, in the
 * same undo step. The guard's verdict on the type is shown live.
 */

const B = GRAPH_TEMPLATE_BOUNDS;

function pathList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function validPathList(text: string): string | null {
  const paths = pathList(text);
  return paths.every(isGraphFieldPath) ? null : "Enter dotted field paths separated by commas";
}

function IssueList({ issues, omitted }: { issues: FieldError[]; omitted: number }) {
  if (issues.length === 0) {
    return (
      <p data-graph-type-valid="" className="text-[11px] text-muted-foreground">
        The type is valid.
      </p>
    );
  }
  return (
    <ul role="alert" data-graph-type-issues="" className="flex flex-col gap-0.5 text-[11px]">
      {issues.map((issue, index) => (
        <li key={`${issue.path}:${index}`} data-graph-type-issue={issue.code}>
          <span className="font-mono text-muted-foreground">{issue.path}</span>{" "}
          <span className="text-failure">{issue.message}</span>
        </li>
      ))}
      {omitted > 0 ? <li className="text-muted-foreground">{omitted} more not shown.</li> : null}
    </ul>
  );
}

function CustomTypeForm({ index, def }: { index: number; def: ArtifactTypeDef }) {
  const { template, edit } = useGraphEditor();
  const ref = graphTypeRef(def);
  const datalistId = useId();
  const [draftNotes, setDraftNotes] = useState<
    | { kind: "notes"; notes: Array<{ path: string; message: string }> }
    | { kind: "errors"; errors: FieldError[] }
    | null
  >(null);

  /** Replaces this type (by position), rewriting refs when its reference changes. */
  const update = (
    label: string,
    recipe: (def: ArtifactTypeDef) => ArtifactTypeDef,
    field?: string,
  ) =>
    edit(
      label,
      (current) => {
        const types = current.types ?? [];
        const before = types[index];
        if (!before) return current;
        const after = recipe(before);
        if (after === before) return current;
        const next: GraphTemplateV1 = {
          ...current,
          types: types.map((entry, position) => (position === index ? after : entry)),
        };
        const fromRef = graphTypeRef(before);
        const toRef = graphTypeRef(after);
        return fromRef === toRef ? next : renameGraphTypeRef(next, fromRef, toRef);
      },
      field ? { coalesce: `type:${index}:${field}` } : {},
    );

  const taken = (template.types ?? [])
    .filter((_, position) => position !== index)
    .map((entry) => graphTypeRef(entry));
  const { issues, omitted } = graphCustomTypeIssues(def, template);
  const arrays = graphSchemaArrayPaths(def.schema);
  const fields = graphSchemaFieldPaths(def.schema).map((entry) => entry.path);
  const maxBytesCap =
    def.storage === "reference" ? B.maxReferenceArtifactBytes : B.maxValueArtifactBytes;

  return (
    <div className="flex flex-col gap-2" data-graph-type-form={ref}>
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <CommitField
          label="Name"
          value={def.name}
          validate={(text) =>
            !isGraphId(text)
              ? "Use a kebab-case name: lower-case letters, digits and -"
              : isGraphBuiltInTypeName(text)
                ? `"${text}" is a built-in type; choose another name`
                : taken.includes(`${text}@${def.version}`)
                  ? `${text}@${def.version} already exists`
                  : null
          }
          onCommit={(text) =>
            update(`Rename type ${ref}`, (current) => ({ ...current, name: text }))
          }
        />
        <NumberField
          label="Version"
          value={def.version}
          min={1}
          max={B.maxTypeVersion}
          onCommit={(value) => {
            if (value === undefined || taken.includes(`${def.name}@${value}`)) return;
            update(`Change ${ref} version`, (current) => ({ ...current, version: value }));
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Ports name it <span className="font-mono text-foreground">{ref}</span>. A change that would
        reject payloads that were valid needs a new version.
      </p>
      <TextField
        label="Label"
        value={def.label ?? ""}
        onChange={(value) =>
          update(
            `Edit ${ref} label`,
            (current) => {
              const next: ArtifactTypeDef = { ...current, label: value };
              if (!value) delete next.label;
              return next;
            },
            "label",
          )
        }
      />
      <TextField
        label="Description"
        multiline
        rows={2}
        value={def.description ?? ""}
        onChange={(value) =>
          update(
            `Edit ${ref} description`,
            (current) => {
              const next: ArtifactTypeDef = { ...current, description: value };
              if (!value) delete next.description;
              return next;
            },
            "description",
          )
        }
      />
      <SelectField
        label="Storage"
        value={def.storage}
        options={[
          { value: "value", label: "Value (inline, up to 384 KiB)" },
          { value: "reference", label: "Reference (a file, up to 32 MiB)" },
        ]}
        onChange={(value) =>
          update(`Change ${ref} storage`, (current) => ({
            ...current,
            storage: value as ArtifactTypeDef["storage"],
          }))
        }
      />
      <FormSection title="Budgets">
        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="Max bytes"
            value={def.budgets.maxBytes}
            min={1}
            max={maxBytesCap}
            onCommit={(value) =>
              value !== undefined &&
              update(`Edit ${ref} budgets`, (current) => ({
                ...current,
                budgets: { ...current.budgets, maxBytes: value },
              }))
            }
          />
          <NumberField
            label="Max string bytes"
            value={def.budgets.maxStringBytes}
            min={1}
            optional
            onCommit={(value) =>
              update(`Edit ${ref} budgets`, (current) => {
                const budgets = { ...current.budgets, maxStringBytes: value };
                if (value === undefined) delete budgets.maxStringBytes;
                return { ...current, budgets };
              })
            }
          />
          <NumberField
            label="Max items"
            value={def.budgets.maxItems}
            min={1}
            max={B.maxArtifactItems}
            optional
            onCommit={(value) =>
              update(`Edit ${ref} budgets`, (current) => {
                const budgets = { ...current.budgets, maxItems: value };
                if (value === undefined) delete budgets.maxItems;
                return { ...current, budgets };
              })
            }
          />
        </div>
      </FormSection>
      <FormSection title="Items (for merges and provenance)">
        <datalist id={datalistId}>
          {arrays.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
        <div className="grid grid-cols-2 gap-2">
          <ItemsPathField
            listId={datalistId}
            value={def.items?.path ?? ""}
            onCommit={(path) =>
              update(`Edit ${ref} items`, (current) => {
                const next = { ...current };
                if (!path) delete next.items;
                else next.items = { path, idPrefix: current.items?.idPrefix ?? "item" };
                return next;
              })
            }
          />
          <CommitField
            label="Item ID prefix"
            value={def.items?.idPrefix ?? ""}
            disabled={!def.items}
            validate={(text) =>
              isGraphId(text) && text.length <= B.maxItemIdPrefixChars
                ? null
                : `A kebab-case id of at most ${B.maxItemIdPrefixChars} characters`
            }
            onCommit={(text) =>
              update(`Edit ${ref} items`, (current) =>
                current.items
                  ? { ...current, items: { ...current.items, idPrefix: text } }
                  : current,
              )
            }
          />
        </div>
        <CommitField
          label="Shared fields (comma-separated paths)"
          value={(def.sharedFields ?? []).join(", ")}
          validate={validPathList}
          hint={fields.length > 0 ? `Fields: ${fields.slice(0, 12).join(", ")}` : undefined}
          onCommit={(text) =>
            update(`Edit ${ref} shared fields`, (current) => {
              const paths = pathList(text);
              const next: ArtifactTypeDef = { ...current, sharedFields: paths };
              if (paths.length === 0) delete next.sharedFields;
              return next;
            })
          }
        />
      </FormSection>
      <FormSection title="Render">
        <TextField
          label="Markdown template"
          multiline
          mono
          rows={4}
          value={def.render?.markdown ?? ""}
          onChange={(value) =>
            update(
              `Edit ${ref} markdown`,
              (current) => {
                const render: ArtifactTypeRender = { ...current.render, markdown: value };
                if (!value) delete render.markdown;
                const next: ArtifactTypeDef = { ...current, render };
                if (Object.keys(render).length === 0) delete next.render;
                return next;
              },
              "markdown",
            )
          }
        />
        <CommitField
          label="Summary fields (comma-separated paths)"
          value={(def.render?.summary ?? []).join(", ")}
          validate={validPathList}
          onCommit={(text) =>
            update(`Edit ${ref} summary`, (current) => {
              const paths = pathList(text);
              const render: ArtifactTypeRender = { ...current.render, summary: paths };
              if (paths.length === 0) delete render.summary;
              const next: ArtifactTypeDef = { ...current, render };
              if (Object.keys(render).length === 0) delete next.render;
              return next;
            })
          }
        />
      </FormSection>
      <FormSection
        title="Example"
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={def.example === undefined}
            onClick={() => {
              const result = draftGraphSchemaFromExample(def.example);
              if (!result.ok) {
                setDraftNotes({ kind: "errors", errors: result.errors });
                return;
              }
              setDraftNotes({ kind: "notes", notes: result.value.notes });
              update(`Schema of ${ref} from its example`, (current) => ({
                ...current,
                schema: result.value.schema,
              }));
            }}
          >
            <Wand2 className="size-3" />
            Schema from example
          </Button>
        }
      >
        <JsonField
          label="Example payload"
          value={def.example}
          rows={6}
          hint="Used by prompt previews and mock runs; it must fit the schema."
          onCommit={(value) =>
            update(`Edit ${ref} example`, (current) => ({ ...current, example: value }), "example")
          }
        />
        {draftNotes?.kind === "errors" ? (
          <ul role="alert" data-graph-schema-draft-errors="" className="text-[11px]">
            {draftNotes.errors.map((error, position) => (
              <li key={`${error.path}:${position}`}>
                <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
                <span className="text-failure">{error.message}</span>
              </li>
            ))}
          </ul>
        ) : draftNotes?.kind === "notes" ? (
          <div data-graph-schema-draft-notes="" className="text-[11px] text-muted-foreground">
            {draftNotes.notes.length === 0 ? (
              <p>Schema drafted from the example. Check every field is what you meant.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {draftNotes.notes.map((note, position) => (
                  <li key={`${note.path}:${position}`}>
                    <span className="font-mono">{note.path}</span> {note.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </FormSection>
      <FormSection title="Schema">
        <GraphSchemaEditor
          schema={def.schema}
          onChange={(schema) =>
            update(`Edit ${ref} schema`, (current) => ({ ...current, schema }), "schema")
          }
        />
      </FormSection>
      <FormSection title="Checks">
        <IssueList issues={issues} omitted={omitted} />
      </FormSection>
    </div>
  );
}

/** `items.path` with suggestions of the schema's list fields. */
function ItemsPathField({
  listId,
  value,
  onCommit,
}: {
  listId: string;
  value: string;
  onCommit: (path: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const commit = () => {
    if (text !== value && (text === "" || isGraphFieldPath(text))) onCommit(text);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        Items list field
      </label>
      <input
        id={id}
        list={listId}
        value={text}
        placeholder="none"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={cn(FIELD_CLASS, "font-mono text-[11px]")}
      />
    </div>
  );
}

export function GraphTypesEditor() {
  const { template, edit } = useGraphEditor();
  const types = template.types ?? [];
  const [selected, setSelected] = useState<number | null>(types.length > 0 ? 0 : null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const active = selected !== null && selected < types.length ? selected : null;
  const atMost = types.length >= B.maxTypes;

  return (
    <FormSection
      title="Custom types"
      actions={
        <AddButton
          label="Add type"
          disabled={atMost}
          onClick={() => {
            const fresh = blankGraphCustomType(types.map((entry) => entry.name));
            edit(`Add type ${graphTypeRef(fresh)}`, (current) => ({
              ...current,
              types: [...(current.types ?? []), fresh],
            }));
            setSelected(types.length);
          }}
        />
      }
    >
      <div data-graph-types-editor="" className="flex flex-col gap-2">
        {types.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No custom types. Ports can use the built-in types, or add one here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Custom types">
            {types.map((def, index) => {
              const ref = graphTypeRef(def);
              const uses = graphTypeUses(template, ref);
              const { issues } = graphCustomTypeIssues(def, template);
              return (
                <li key={`${ref}:${index}`} data-graph-type-row={ref}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={active === index}
                      onClick={() => setSelected(active === index ? null : index)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent",
                        active === index && "bg-accent",
                      )}
                    >
                      <span className="truncate font-mono text-foreground">{ref}</span>
                      {def.label ? (
                        <span className="truncate text-muted-foreground">{def.label}</span>
                      ) : null}
                      {issues.length > 0 ? (
                        <span className="ml-auto rounded-full bg-failure/20 px-1.5 text-[10px] text-failure">
                          {issues.length}
                        </span>
                      ) : null}
                    </button>
                    <RemoveButton
                      label={`Remove type ${ref}`}
                      onClick={() => {
                        if (uses.length > 0 && confirmRemove !== index) {
                          setConfirmRemove(index);
                          return;
                        }
                        setConfirmRemove(null);
                        edit(`Remove type ${ref}`, (current) => {
                          const next: GraphTemplateV1 = {
                            ...current,
                            types: (current.types ?? []).filter(
                              (_, position) => position !== index,
                            ),
                          };
                          if (next.types?.length === 0) delete next.types;
                          return next;
                        });
                        setSelected(null);
                      }}
                    />
                  </div>
                  {confirmRemove === index ? (
                    <p role="alert" className="px-1.5 text-[11px] text-amber-300">
                      {uses.join(", ")} {uses.length === 1 ? "uses" : "use"} {ref}. Remove again to
                      delete it anyway; those ports will not resolve.
                    </p>
                  ) : null}
                  {active === index ? (
                    <EntryCard className="mt-1">
                      <CustomTypeForm index={index} def={def} />
                    </EntryCard>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FormSection>
  );
}
