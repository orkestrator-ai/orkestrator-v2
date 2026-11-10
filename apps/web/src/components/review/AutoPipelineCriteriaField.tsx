import { ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The draft's acceptance criteria as a numbered list of single-line entries,
 * styled like every other text field in the app. Line breaks typed or pasted
 * into an entry become spaces, because the ticket stores one criterion per line.
 */
export function AutoPipelineCriteriaField({
  criteria,
  onChange,
}: {
  criteria: readonly string[];
  onChange: (criteria: string[]) => void;
}) {
  return (
    <div className="space-y-3">
      {criteria.length ? (
        <ol className="space-y-2">
          {criteria.map((criterion, index) => {
            const invalid = !criterion.trim();
            const errorId = `criterion-${index}-error`;
            return (
              <li key={index} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-2 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                >
                  {index + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <Textarea
                    aria-label={`Criterion ${index + 1}`}
                    rows={1}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? errorId : undefined}
                    placeholder="Describe one observable outcome…"
                    className="min-h-9 resize-none py-1.5 leading-relaxed"
                    value={criterion}
                    onChange={(event) =>
                      onChange(
                        criteria.map((value, i) =>
                          i === index ? event.target.value.replace(/[\r\n]+/g, " ") : value,
                        ),
                      )
                    }
                  />
                  {invalid && (
                    <p id={errorId} className="mt-1 text-xs text-destructive">
                      Enter an acceptance criterion.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={index === 0}
                    aria-label={`Move criterion ${index + 1} up`}
                    title="Move up"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const next = [...criteria];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      onChange(next);
                    }}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove criterion ${index + 1}`}
                    title="Remove"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(criteria.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
          Add at least one acceptance criterion before confirming.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-7 gap-1.5"
        onClick={() => onChange([...criteria, ""])}
      >
        <Plus className="size-3.5" />
        Add criterion
      </Button>
    </div>
  );
}
