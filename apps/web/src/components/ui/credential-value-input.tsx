import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LINE_BREAK = /[\r\n]/u;

/** A password field with a private paste path for multiline values, including CRLF. */
export function CredentialValueInput({
  value,
  onValueChange,
  onFocus,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onFocus?: () => void;
  className?: string;
}) {
  const multiline = LINE_BREAK.test(value);
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <Input
        aria-label="Credential value"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={multiline ? "Multiline value pasted" : undefined}
        className="min-w-0 flex-1"
        value={multiline ? "" : value}
        onFocus={onFocus}
        onChange={(event) => onValueChange(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text/plain");
          if (!LINE_BREAK.test(pasted) && !multiline) return;
          event.preventDefault();
          const { selectionStart, selectionEnd } = event.currentTarget;
          onValueChange(
            multiline
              ? pasted
              : value.slice(0, selectionStart ?? 0) + pasted + value.slice(selectionEnd ?? 0),
          );
        }}
      />
      {multiline ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Clear credential value"
          onClick={() => onValueChange("")}
        >
          Clear
        </Button>
      ) : null}
    </span>
  );
}
