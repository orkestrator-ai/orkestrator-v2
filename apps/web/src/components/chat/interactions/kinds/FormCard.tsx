import { useMemo, useState } from "react";
import {
  formErrors,
  initialFormValues,
  pruneHiddenValues,
  summarizeFormValues,
  type FormKindResult,
  type FormKindSpec,
  type FormValues,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { ActionBar, type KindProps } from "../shared";
import { FormFields } from "./FormFields";

/**
 * Feature 2: rich forms. Local validation guides; the backend runs the same
 * validator and decides. Hidden conditional values are pruned before review,
 * and the review step lists exactly what will be sent and what is discarded.
 */
export function FormCard({ view, spec, draft, setDraft, act, disabled, actions }: KindProps<FormKindSpec>) {
  const values = (draft as FormValues | undefined) ?? initialFormValues(spec.form.fields);
  const [reviewing, setReviewing] = useState(false);
  const [touched, setTouched] = useState(false);
  const pruned = useMemo(() => pruneHiddenValues(spec.form.fields, values), [spec.form.fields, values]);
  const errors = useMemo(() => formErrors(spec.form, pruned.values), [spec.form, pruned.values]);
  const valid = Object.keys(errors).length === 0;
  const submitted = disabled ? (view.receipts.at(-1)?.result as FormKindResult | undefined) : undefined;
  const submit = actions[0];

  if (submitted) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">Submitted values</p>
        <pre className="whitespace-pre-wrap rounded bg-muted/30 px-3 py-2 text-xs">{summarizeFormValues(spec.form.fields, submitted.values).join("\n")}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {spec.purpose ? <p className="text-sm leading-relaxed">{spec.purpose}</p> : null}
      {reviewing ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Review what will be sent to this session</p>
          {spec.reviewNote ? <p className="text-xs text-muted-foreground">{spec.reviewNote}</p> : null}
          <pre className="whitespace-pre-wrap rounded bg-muted/30 px-3 py-2 text-xs">{summarizeFormValues(spec.form.fields, pruned.values).join("\n") || "(no values)"}</pre>
          {pruned.removed.length ? <p className="text-xs text-muted-foreground">Hidden fields that will be discarded: {pruned.removed.join(", ")}</p> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
              Back to editing
            </Button>
            {submit ? (
              <Button size="sm" disabled={disabled || !valid} onClick={() => act(submit.id, { schemaRevision: view.request.revision, values: pruned.values })}>
                {submit.label}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <FormFields fields={spec.form.fields} values={values} onChange={(next) => { setTouched(true); setDraft(next); }} errors={touched ? errors : {}} disabled={disabled} />
          {pruned.removed.length ? <p className="text-xs text-muted-foreground">Hidden by your choices and not sent: {pruned.removed.join(", ")}</p> : null}
          <ActionBar
            actions={actions.map((a) => ({ ...a, label: "Review" }))}
            disabled={disabled}
            primaryDisabledReason={!valid && touched ? `Fix: ${Object.values(errors)[0]}` : null}
            onAction={() => {
              setTouched(true);
              if (valid) setReviewing(true);
            }}
          />
        </>
      )}
    </div>
  );
}
