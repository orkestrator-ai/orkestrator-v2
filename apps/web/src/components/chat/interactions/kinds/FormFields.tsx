import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import {
  FORM_LIMITS,
  initialFormValues,
  isFieldVisible,
  newRepeatItemId,
  type FormField,
  type FormRepeatItem,
  type FormValue,
  type FormValues,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { inputClass, textareaClass } from "../shared";

/**
 * The shared field renderer for the form vocabulary (feature 2): one control
 * per declared field type, labelled, with its error beside it. Sliders always
 * come with a numeric input. Values keep their type: an emptied number field
 * is removed (or null when the field is nullable), never coerced to 0.
 */
export function FormFields({
  fields,
  values,
  onChange,
  errors,
  disabled,
  path = "",
}: {
  fields: readonly FormField[];
  values: FormValues;
  onChange: (values: FormValues) => void;
  errors: Record<string, string>;
  disabled: boolean;
  path?: string;
}) {
  const set = (fieldId: string, value: FormValue | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[fieldId];
    else next[fieldId] = value;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        if (!isFieldVisible(field, values)) return null;
        return <Field key={field.id} field={field} value={values[field.id]} onChange={(v) => set(field.id, v)} errors={errors} disabled={disabled} path={`${path}${path ? "." : ""}${field.id}`} />;
      })}
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
  errors,
  disabled,
  path,
}: {
  field: FormField;
  value: FormValue | undefined;
  onChange: (value: FormValue | undefined) => void;
  errors: Record<string, string>;
  disabled: boolean;
  path: string;
}) {
  const id = useId();
  const error = errors[path];
  const describedBy = error ? `${id}-error` : field.description ? `${id}-description` : undefined;
  const label = (
    <label htmlFor={id} className="flex items-baseline gap-1.5 text-sm font-medium">
      {field.label}
      {field.required ? <span className="text-failure" aria-hidden>*</span> : null}
      {field.inferred ? <span className="rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground" title="The agent pre-filled this value; check it">inferred</span> : null}
      {"unit" in field && field.unit ? <span className="text-xs font-normal text-muted-foreground">({field.unit})</span> : null}
    </label>
  );
  const help = (
    <>
      {field.description ? <p id={`${id}-description`} className="text-xs text-muted-foreground">{field.description}</p> : null}
      {error ? <p id={`${id}-error`} className="text-xs text-failure" role="alert">{error}</p> : null}
    </>
  );
  const common = { id, disabled, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy, "aria-required": field.required || undefined };
  switch (field.type) {
    case "text":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input {...common} className={inputClass} value={typeof value === "string" ? value : ""} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />
          {help}
        </div>
      );
    case "multiline":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <textarea {...common} className={textareaClass} rows={3} value={typeof value === "string" ? value : ""} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />
          {help}
        </div>
      );
    case "number": {
      const numeric = typeof value === "number" ? value : null;
      const parse = (text: string) => {
        if (text.trim() === "") return field.nullable ? null : undefined;
        const n = Number(text);
        return Number.isFinite(n) ? n : undefined;
      };
      return (
        <div className="flex flex-col gap-1">
          {label}
          <div className="flex items-center gap-2">
            {field.slider && field.minimum !== undefined && field.maximum !== undefined ? (
              <input
                type="range"
                aria-label={`${field.label} slider`}
                className="min-w-0 flex-1 accent-primary"
                min={field.minimum}
                max={field.maximum}
                step={field.step ?? (field.integer ? 1 : "any")}
                value={numeric ?? field.minimum}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
              />
            ) : null}
            <input
              {...common}
              type="number"
              inputMode={field.integer ? "numeric" : "decimal"}
              className={cn(inputClass, field.slider ? "w-28" : "")}
              min={field.minimum}
              max={field.maximum}
              step={field.step ?? (field.integer ? 1 : "any")}
              value={numeric === null ? "" : String(numeric)}
              onChange={(e) => onChange(parse(e.target.value))}
            />
          </div>
          {help}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input {...common} type="checkbox" className="size-4 accent-primary" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span className="font-medium">{field.label}</span>
            {field.required ? <span className="sr-only">(required)</span> : null}
          </label>
          {help}
        </div>
      );
    case "enum":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select {...common} className={inputClass} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? (field.nullable ? null : undefined) : e.target.value)}>
            <option value="">{field.required ? "Choose…" : "None"}</option>
            {field.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {help}
        </div>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="flex flex-col gap-1" disabled={disabled} aria-describedby={describedBy}>
          <legend className="text-sm font-medium">
            {field.label}
            {field.required ? <span className="text-failure"> *</span> : null}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {field.options.map((option) => (
              <label key={option.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.includes(option.id)}
                  onChange={(e) => onChange(e.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))}
                />
                {option.label}
              </label>
            ))}
          </div>
          {help}
        </fieldset>
      );
    }
    case "date": {
      if (field.mode === "local-datetime") {
        const record = value && typeof value === "object" && !Array.isArray(value) && "dateTime" in value ? (value as { dateTime: string; timeZone: string }) : null;
        const zone = record?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        return (
          <div className="flex flex-col gap-1">
            {label}
            <div className="flex flex-wrap gap-2">
              <input {...common} type="datetime-local" className={cn(inputClass, "w-auto")} value={record?.dateTime ?? ""} onChange={(e) => onChange(e.target.value ? { dateTime: e.target.value, timeZone: zone } : undefined)} />
              <input className={cn(inputClass, "w-48")} aria-label={`${field.label} time zone`} value={zone} disabled={disabled} onChange={(e) => onChange({ dateTime: record?.dateTime ?? "", timeZone: e.target.value })} />
            </div>
            {help}
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input
            {...common}
            type={field.mode === "local-date" ? "date" : "datetime-local"}
            className={cn(inputClass, "w-auto")}
            value={typeof value === "string" ? (field.mode === "instant" ? toLocalInput(value) : value) : ""}
            onChange={(e) => onChange(e.target.value ? (field.mode === "instant" ? new Date(e.target.value).toISOString() : e.target.value) : undefined)}
          />
          {field.mode === "instant" ? <p className="text-[11px] text-muted-foreground">Entered in your local time; sent as an exact instant.</p> : null}
          {help}
        </div>
      );
    }
    case "file":
    case "list": {
      const items = field.type === "file" && !field.multiple ? null : Array.isArray(value) ? (value as Array<string | number>) : [];
      if (!items) {
        return (
          <div className="flex flex-col gap-1">
            {label}
            <input {...common} className={cn(inputClass, "font-mono")} placeholder="path/in/workspace" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
            {help}
          </div>
        );
      }
      const numeric = field.type === "list" && field.itemType === "number";
      const max = field.type === "list" ? (field.maxItems ?? FORM_LIMITS.repeatItems) : 100;
      return (
        <div className="flex flex-col gap-1">
          {label}
          {items.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                className={cn(inputClass, field.type === "file" && "font-mono")}
                aria-label={`${field.label} item ${index + 1}`}
                type={numeric ? "number" : "text"}
                value={String(item)}
                disabled={disabled}
                onChange={(e) => onChange(items.map((x, i) => (i === index ? (numeric ? Number(e.target.value) : e.target.value) : x)))}
              />
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove ${field.label} item ${index + 1}`} disabled={disabled} onClick={() => onChange(items.filter((_, i) => i !== index))}>
                <Minus className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" className="self-start" disabled={disabled || items.length >= max} onClick={() => onChange([...items, numeric ? 0 : ""])}>
            <Plus className="size-3.5" aria-hidden />
            Add {field.label.toLowerCase()}
          </Button>
          {help}
        </div>
      );
    }
    case "group": {
      const nested = value && typeof value === "object" && !Array.isArray(value) ? (value as FormValues) : initialFormValues(field.fields);
      return (
        <fieldset className="flex flex-col gap-2 rounded-md border border-border/60 p-3" disabled={disabled}>
          <legend className="px-1 text-sm font-medium">{field.label}</legend>
          {field.description ? <p className="text-xs text-muted-foreground">{field.description}</p> : null}
          <FormFields fields={field.fields} values={nested} onChange={(v) => onChange(v)} errors={errors} disabled={disabled} path={path} />
        </fieldset>
      );
    }
    case "repeat": {
      const items = Array.isArray(value) ? (value as FormRepeatItem[]) : [];
      const max = field.maxItems ?? FORM_LIMITS.repeatItems;
      return (
        <fieldset className="flex flex-col gap-2" disabled={disabled}>
          <legend className="text-sm font-medium">
            {field.label} <span className="text-xs font-normal text-muted-foreground">({items.length}{field.maxItems ? ` of at most ${field.maxItems}` : ""})</span>
          </legend>
          {items.map((item, index) => (
            <div key={item.itemId} className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {field.label} #{index + 1}
                </span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={index === 0} onClick={() => onChange(swap(items, index, index - 1))}>
                    Move up
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={index === items.length - 1} onClick={() => onChange(swap(items, index, index + 1))}>
                    Move down
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onChange(items.filter((x) => x.itemId !== item.itemId))}>
                    Remove
                  </Button>
                </div>
              </div>
              <FormFields
                fields={field.fields}
                values={item.values}
                onChange={(v) => onChange(items.map((x) => (x.itemId === item.itemId ? { itemId: x.itemId, values: v } : x)))}
                errors={errors}
                disabled={disabled}
                path={`${path}[${index}].values`}
              />
            </div>
          ))}
          <Button size="sm" variant="outline" className="self-start" disabled={items.length >= max} onClick={() => onChange([...items, { itemId: newRepeatItemId(), values: initialFormValues(field.fields) }])}>
            <Plus className="size-3.5" aria-hidden />
            Add {field.label.toLowerCase()}
          </Button>
          {errors[path] ? <p className="text-xs text-failure" role="alert">{errors[path]}</p> : null}
        </fieldset>
      );
    }
  }
}

function swap<T>(items: readonly T[], a: number, b: number): T[] {
  const next = [...items];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
