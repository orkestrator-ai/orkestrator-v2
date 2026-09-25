import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import type { DesignElement, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignFailure, DesignFrameMeta } from "@orkestrator/protocol/design-operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_STYLE_PROPERTIES,
  checkDeclaration,
  checkPropertyName,
  formatInline,
  isCustomProperty,
} from "./design-css";
import {
  findEarlierInspectorDraft,
  readInspectorDraft,
  writeInspectorDraft,
  type InspectorDraft,
  type InspectorDraftTarget,
} from "./design-inspector-drafts";
import { groupedPropertyNames, inspectorSections } from "./design-inspector-properties";
import type { DesignSelection, SelectionValidity } from "./design-selection";
import { DesignStyleField, type DesignStyleProperty } from "./DesignStyleField";
import type { DesignFrameBridge } from "./frame-bridge";

export interface DesignInspectorStatus {
  pending: boolean;
  failure?: DesignFailure;
  unchanged?: string[];
}

export interface DesignInspectorProps {
  /** Controller key: namespace for retained drafts. */
  environmentKey: string;
  selection: DesignSelection;
  validity: SelectionValidity;
  /** Committed frame. */
  frame: DesignFrame | undefined;
  meta?: DesignFrameMeta;
  /** Live iframe runtime for local preview; absent while the frame is culled. */
  bridge?: DesignFrameBridge;
  /** v1 backend: no structure identity. */
  legacy: boolean;
  status: DesignInspectorStatus;
  /** Returns the intent id, or undefined when the shell refused the edit. */
  onApply: (styles: Record<string, string | null>) => string | undefined;
  onReselect: () => void;
  onClose: () => void;
  onAskAgent: () => void;
}

const PREVIEW_DELAY_MS = 150;
const PREVIEW_ATTEMPTS = 8;
const EMPTY_DRAFT: InspectorDraft = { values: {}, bases: {} };

/** Authored baseline: the inline declaration, or the computed value for legacy runtimes. */
function baselineOf(element: DesignElement, name: string): string {
  if (!element.inline) return element.styles[name] ?? "";
  return formatInline(element.inline[name], element.inlinePriority?.[name]);
}

function same(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? "").trim() === (b ?? "").trim();
}

function sendable(values: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value === null || value.trim() === "" ? null : value.trim(),
    ]),
  );
}

function rejectedProperties(failure: DesignFailure | undefined): string[] {
  const properties = failure?.details?.properties;
  if (Array.isArray(properties)) return properties.map(String);
  if (typeof properties === "string") return properties.split(",").map((name) => name.trim());
  return [];
}

export function DesignInspector(props: DesignInspectorProps) {
  const target: InspectorDraftTarget = {
    environmentKey: props.environmentKey,
    frameId: props.selection.frameId,
    selector: props.selection.element.selector,
    ...(props.selection.structureId ? { structureId: props.selection.structureId } : {}),
  };
  // A new structure identity is a new target: its draft is looked up afresh,
  // and a draft from the earlier structure is offered rather than carried over.
  const key = JSON.stringify(target);
  return <InspectorBody key={key} {...props} target={target} />;
}

interface Flight {
  raw: Record<string, string | null>;
  sawPending: boolean;
  failure: DesignFailure | undefined;
  unchanged: string[] | undefined;
}

function InspectorBody({
  target,
  selection,
  validity,
  frame,
  meta,
  bridge,
  legacy,
  status,
  onApply,
  onReselect,
  onClose,
  onAskAgent,
}: DesignInspectorProps & { target: InspectorDraftTarget }) {
  const element = selection.element;
  const [draft, setDraft] = useState<InspectorDraft>(
    () => readInspectorDraft(target) ?? EMPTY_DRAFT,
  );
  const [earlier, setEarlier] = useState(() =>
    readInspectorDraft(target) ? undefined : findEarlierInspectorDraft(target),
  );
  const [added, setAdded] = useState<string[]>([]);
  const [newProperty, setNewProperty] = useState("");
  const [newPropertyError, setNewPropertyError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [rejected, setRejected] = useState<Record<string, string | null>>({});
  const [previewInvalid, setPreviewInvalid] = useState<{ signature: string; invalid: string[] }>();
  const flight = useRef<Flight | null>(null);
  const aside = useRef<HTMLElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<"apply" | { property: string } | null>(null);
  const previewed = useRef(new Set<string>());
  const targetRef = useRef(target);
  targetRef.current = target;

  const editable = validity === "current" || validity === "refresh";
  const contentKey = meta?.contentId ?? (frame ? `revision:${frame.revision}` : undefined);
  const latest = useRef({ frame, contentKey, bridge });
  latest.current = { frame, contentKey, bridge };

  useEffect(() => {
    writeInspectorDraft(targetRef.current, draft);
  }, [draft]);

  // Changed fields relative to the current authored baseline.
  const changes = useMemo(() => {
    const result: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(draft.values))
      if (!same(value, baselineOf(element, name))) result[name] = value;
    return result;
  }, [draft.values, element]);
  const proposed = useMemo(() => sendable(changes), [changes]);
  const signature = JSON.stringify(proposed);
  const changedNames = Object.keys(proposed);

  const checks = useMemo(() => {
    const errors: Record<string, string> = {};
    const notes: Record<string, string> = {};
    for (const [name, value] of Object.entries(changes)) {
      const result = checkDeclaration(name, value);
      if (!result.ok) errors[name] = result.error;
      else if (!result.remove && result.note) notes[name] = result.note;
      if (!errors[name] && name in rejected && same(rejected[name], value))
        errors[name] = "Rejected by the design service; enter a different value";
      if (
        !errors[name] &&
        previewInvalid?.signature === signature &&
        previewInvalid.invalid.includes(name)
      )
        errors[name] = "The browser rejected this value";
    }
    for (const [name, base] of Object.entries(draft.bases)) {
      const current = baselineOf(element, name);
      if (name in changes && !same(base, current))
        notes[name] = `Changed elsewhere since you edited; now ${current || "not set inline"}`;
    }
    return { errors, notes };
  }, [changes, draft.bases, element, previewInvalid, rejected, signature]);
  const errorNames = Object.keys(checks.errors);
  const tooMany = changedNames.length > MAX_STYLE_PROPERTIES;
  const canApply =
    editable &&
    changedNames.length > 0 &&
    errorNames.length === 0 &&
    !tooMany &&
    !status.pending &&
    !submitting;

  const update = useCallback(
    (name: string, value: string | null) =>
      setDraft((current) => {
        const baseline = baselineOf(element, name);
        const values = { ...current.values };
        const bases = { ...current.bases };
        if (same(value, baseline)) {
          delete values[name];
          delete bases[name];
        } else {
          values[name] = value;
          bases[name] = bases[name] ?? baseline;
        }
        return { values, bases };
      }),
    [element],
  );
  const revert = (name: string) => update(name, baselineOf(element, name));
  const discard = () => {
    setDraft(EMPTY_DRAFT);
    setRejected({});
    setAdded([]);
  };

  // Acknowledgement: clear only the fields that were applied, keep the rest.
  useEffect(() => {
    const current = flight.current;
    if (!current) return;
    if (status.pending) {
      current.sawPending = true;
      return;
    }
    if (
      !current.sawPending &&
      status.failure === current.failure &&
      status.unchanged === current.unchanged
    )
      return;
    flight.current = null;
    setSubmitting(false);
    focusRequest.current = "apply";
    if (status.failure) {
      const names = rejectedProperties(status.failure);
      setRejected(
        Object.fromEntries(
          names.filter((name) => name in current.raw).map((name) => [name, current.raw[name]!]),
        ),
      );
      return;
    }
    setRejected({});
    for (const name of Object.keys(current.raw)) previewed.current.delete(name);
    setDraft((draftNow) => {
      const values = { ...draftNow.values };
      const bases = { ...draftNow.bases };
      for (const [name, value] of Object.entries(current.raw))
        if (name in values && same(values[name], value)) {
          delete values[name];
          delete bases[name];
        }
      return { values, bases };
    });
  }, [status.pending, status.failure, status.unchanged]);

  // Focus restoration after acknowledgement, stale recovery, or adding a property.
  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const root = aside.current;
    const active = document.activeElement;
    if (!root || (active && active !== document.body && !root.contains(active))) return;
    if (typeof request === "object") {
      const field = Array.from(root.querySelectorAll<HTMLElement>("[data-property]")).find(
        (candidate) => candidate.dataset.property === request.property,
      );
      field?.querySelector<HTMLElement>("input:not([type=color]), button[role=combobox]")?.focus();
      return;
    }
    if (applyButton.current && !applyButton.current.disabled) applyButton.current.focus();
    else
      root
        .querySelector<HTMLElement>(
          "[data-inspector-fields] input:not(:disabled), [data-inspector-fields] button:not(:disabled)",
        )
        ?.focus();
  });

  // Content re-rendered by the frame view drops any local preview.
  useEffect(() => {
    previewed.current.clear();
  }, [contentKey]);

  // Local live preview: temporary runtime styles, never serialized.
  // `proposed` is keyed by `signature` (a new object every render otherwise);
  // contentKey re-previews after the frame view re-renders authoritative HTML.
  /* oxlint-disable react-hooks/exhaustive-deps */
  const hasErrors = errorNames.length > 0 || tooMany;
  useEffect(() => {
    if (!bridge) return;
    const names = Object.keys(proposed);
    const restore = [...previewed.current].some((name) => !(name in proposed));
    const wantPreview = editable && !hasErrors && names.length > 0;
    if (!restore && !wantPreview) return;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const { frame: current, contentKey: expected } = latest.current;
      if (!active || bridge.closed || !current) return;
      if (bridge.renderedContentId !== expected) {
        if (++attempts < PREVIEW_ATTEMPTS)
          timer = setTimeout(() => void run().catch(() => undefined), PREVIEW_DELAY_MS);
        return;
      }
      if (restore) {
        await bridge.ask({ op: "render", html: current.html });
        previewed.current.clear();
      }
      if (!active || !wantPreview) return;
      const result = await bridge.ask<{ invalid?: string[] } | undefined>({
        op: "previewStyles",
        selector: element.selector,
        styles: proposed,
      });
      for (const name of names) previewed.current.add(name);
      if (active) setPreviewInvalid({ signature, invalid: result?.invalid ?? [] });
    };
    timer = setTimeout(() => void run().catch(() => undefined), PREVIEW_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge, editable, hasErrors, signature, element.selector, contentKey]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Leaving the inspector restores authoritative content over an unsent preview.
  useEffect(
    () => () => {
      const { frame: current, contentKey: expected, bridge: live } = latest.current;
      if (!previewed.current.size || !live || live.closed || !current) return;
      if (live.renderedContentId !== expected) return;
      previewed.current.clear();
      void live.ask({ op: "render", html: current.html }).catch(() => undefined);
    },
    [],
  );

  const apply = () => {
    if (!canApply) return;
    const raw = { ...changes };
    const id = onApply(proposed);
    if (id === undefined) return;
    flight.current = {
      raw,
      sawPending: false,
      failure: status.failure,
      unchanged: status.unchanged,
    };
    setSubmitting(true);
  };

  const addProperty = () => {
    const name = newProperty.trim();
    const error = checkPropertyName(name);
    if (error) {
      setNewPropertyError(error);
      return;
    }
    setNewPropertyError(undefined);
    setNewProperty("");
    if (!added.includes(name)) setAdded((current) => [...current, name]);
    focusRequest.current = { property: name };
  };

  const inline = element.inline ?? {};
  const present = (name: string) =>
    name in element.styles || name in inline || name in draft.values;
  const fieldFor = (property: DesignStyleProperty) => {
    const name = property.name;
    const baseline = baselineOf(element, name);
    const inDraft = name in draft.values;
    const changed = name in changes;
    const hasInline = Boolean(element.inline && name in inline);
    return (
      <DesignStyleField
        key={name}
        property={property}
        scopeKey={`${selection.frameId}:${element.selector}`}
        value={inDraft ? (draft.values[name] ?? "") : baseline}
        computed={element.styles[name]}
        inline={hasInline}
        changed={changed}
        error={checks.errors[name]}
        note={checks.notes[name]}
        disabled={!editable}
        onChange={(value) => update(name, value)}
        onRevert={changed ? () => revert(name) : undefined}
        onReset={
          hasInline && !(inDraft && draft.values[name] === null)
            ? () => update(name, null)
            : undefined
        }
      />
    );
  };

  const extraNames = Array.from(
    new Set([
      ...Object.keys(element.styles),
      ...Object.keys(inline),
      ...Object.keys(draft.values),
      ...added,
    ]),
  ).filter((name) => !groupedPropertyNames.has(name));
  const advancedNames = extraNames.filter(
    (name) => isCustomProperty(name) || name in draft.values || added.includes(name),
  );
  const moreNames = extraNames.filter((name) => !advancedNames.includes(name));
  const failureProperties = rejectedProperties(status.failure);
  const newPropertyErrorId = "design-inspector-new-property-error";

  return (
    <aside
      ref={aside}
      aria-label="Element inspector"
      className="design-inspector flex w-72 shrink-0 flex-col overflow-hidden border-l border-divider bg-background text-xs"
    >
      <div className="border-b border-divider px-3 py-2">
        <div className="flex items-center gap-1">
          <h3 className="min-w-0 flex-1 truncate font-semibold">{element.tag}</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={onAskAgent}
          >
            <MessageSquare className="size-3" />
            Ask agent
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X className="size-3" />
          </Button>
        </div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={element.selector}>
          {element.selector}
        </p>
        {element.svg && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            SVG element: some CSS properties behave differently, and presentation attributes are not
            edited here.
          </p>
        )}
        {legacy && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            This backend does not track element structure; any frame change requires reselecting.
          </p>
        )}
      </div>
      {(validity === "stale" || validity === "missing") && (
        <div role="status" className="space-y-2 border-b border-divider px-3 py-2 text-amber-500">
          <p>
            {validity === "missing"
              ? "This frame no longer exists."
              : "Changed elsewhere — Reselect the element to keep editing."}
            {changedNames.length > 0 ? " Your draft is kept." : ""}
          </p>
          <div className="flex gap-2">
            {validity === "stale" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={onReselect}
              >
                Reselect
              </Button>
            )}
            {changedNames.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={discard}
              >
                Discard draft
              </Button>
            )}
          </div>
        </div>
      )}
      {earlier && (
        <div role="status" className="space-y-2 border-b border-divider px-3 py-2">
          <p>
            You have unsent values for this element from before the frame changed (
            {Object.keys(earlier.draft.values).join(", ")}).
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={!editable}
              onClick={() => {
                writeInspectorDraft(earlier.target, undefined);
                setDraft({
                  values: { ...earlier.draft.values, ...draft.values },
                  bases: { ...earlier.draft.bases, ...draft.bases },
                });
                setEarlier(undefined);
                const first = Object.keys(earlier.draft.values)[0];
                if (first) focusRequest.current = { property: first };
              }}
            >
              Restore draft
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                writeInspectorDraft(earlier.target, undefined);
                setEarlier(undefined);
              }}
            >
              Discard earlier draft
            </Button>
          </div>
        </div>
      )}
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <fieldset
            data-inspector-fields
            disabled={!editable}
            className="min-w-0 divide-y divide-divider disabled:opacity-60"
          >
            {inspectorSections.map((section) => {
              const properties = section.properties.filter((property) => present(property.name));
              if (!properties.length) return null;
              return (
                <section
                  key={section.title}
                  aria-label={section.title}
                  className="space-y-2.5 px-3 py-3"
                >
                  <h4 className="font-semibold">{section.title}</h4>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
                    {properties.map(fieldFor)}
                  </div>
                </section>
              );
            })}
            <section aria-label="Advanced" className="space-y-2.5 px-3 py-3">
              <h4 className="font-semibold">Advanced</h4>
              {advancedNames.length > 0 && (
                <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
                  {advancedNames.map((name) => fieldFor({ name, label: name, wide: true }))}
                </div>
              )}
              <div className="space-y-1">
                <div className="flex gap-1.5">
                  <Input
                    aria-label="New property name"
                    className="h-7 px-2 text-xs md:text-xs"
                    placeholder="--brand-color"
                    value={newProperty}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={newPropertyError ? true : undefined}
                    aria-describedby={newPropertyError ? newPropertyErrorId : undefined}
                    onChange={(event) => {
                      setNewProperty(event.target.value);
                      setNewPropertyError(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addProperty();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={addProperty}
                  >
                    Add property
                  </Button>
                </div>
                {newPropertyError && (
                  <p id={newPropertyErrorId} className="text-[10px] text-destructive">
                    {newPropertyError}
                  </p>
                )}
              </div>
            </section>
            {moreNames.length > 0 && (
              <details className="px-3 py-3">
                <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-ring">
                  More styles
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {moreNames.map((name) => fieldFor({ name, label: name, wide: true }))}
                </div>
              </details>
            )}
          </fieldset>
          <details className="border-t border-divider px-3 py-3">
            <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-ring">
              Details
            </summary>
            <dl className="mt-2 max-h-60 space-y-2 overflow-y-auto break-all">
              <div>
                <dt className="font-medium">Element</dt>
                <dd className="text-muted-foreground">
                  {element.tag} · {Math.round(element.rect.width)} ×{" "}
                  {Math.round(element.rect.height)}
                </dd>
              </div>
              {element.text && (
                <div>
                  <dt className="font-medium">Text</dt>
                  <dd className="whitespace-pre-wrap text-muted-foreground">{element.text}</dd>
                  {element.textTruncated && (
                    <dd className="text-[10px] text-muted-foreground italic">Text truncated</dd>
                  )}
                </div>
              )}
              {Object.entries(element.attributes).map(([name, value]) => (
                <div key={name}>
                  <dt className="font-medium">{name}</dt>
                  <dd className="text-muted-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            {element.attributesTruncated && (
              <p className="mt-2 text-[10px] text-muted-foreground italic">
                Some attributes are not shown.
              </p>
            )}
          </details>
        </div>
        <div className="shrink-0 space-y-2 border-t border-divider bg-background p-3">
          {(status.pending || submitting) && (
            <p role="status" className="text-muted-foreground">
              Applying…
            </p>
          )}
          {!status.pending && !submitting && status.failure && (
            <div role="alert" className="space-y-1 text-destructive">
              <p className="break-words">{status.failure.message}</p>
              {failureProperties.length > 0 && (
                <p className="break-words">Rejected: {failureProperties.join(", ")}</p>
              )}
            </div>
          )}
          {!status.pending &&
            !submitting &&
            !status.failure &&
            status.unchanged &&
            status.unchanged.length > 0 && (
              <p role="status" className="break-words text-muted-foreground">
                No change: values already applied ({status.unchanged.join(", ")})
              </p>
            )}
          {(errorNames.length > 0 || tooMany) && (
            <p className="text-destructive">
              {tooMany
                ? `Apply at most ${MAX_STYLE_PROPERTIES} properties at once.`
                : `Fix ${errorNames.length === 1 ? "1 invalid value" : `${errorNames.length} invalid values`} before applying.`}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              ref={applyButton}
              size="sm"
              className="flex-1 text-xs"
              disabled={!canApply}
              type="submit"
            >
              Apply styles
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              disabled={!Object.keys(draft.values).length && !added.length}
              type="button"
              onClick={discard}
            >
              Reset
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
