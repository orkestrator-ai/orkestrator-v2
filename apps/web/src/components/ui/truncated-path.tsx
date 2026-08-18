import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

interface TruncatedPathProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  /** Directory portion of the path, without a trailing separator. Falsy renders the basename alone. */
  directory?: string | null;
  /** Separator placed between the directory and the basename. */
  separator?: string;
  /** Basename, rendered whole — it is the part worth reading. */
  filename: string;
  directoryClassName?: string;
  filenameClassName?: string;
}

/**
 * A file path rendered as a shrinking directory segment followed by an
 * unshrinkable basename.
 *
 * The directory is laid out RTL so that CSS truncation eats the *start* of the
 * path — the uninteresting end — and keeps the segments nearest the filename.
 * That base direction also drives the Unicode bidirectional algorithm, so the
 * directory text has to stay inside an LTR bidi isolate: without one, a leading
 * neutral character (the dot of ".github", the paren of "(group)") resolves to
 * the RTL embedding level and is reordered to the visual end, so ".github"
 * renders as "github.".
 *
 * Both behaviours are geometry, not markup, so they are covered in a real
 * browser by `e2e/PathTruncation.spec.ts` rather than by a DOM unit test.
 */
export function TruncatedPath({
  directory,
  separator = "/",
  filename,
  className,
  directoryClassName,
  filenameClassName,
  ...props
}: TruncatedPathProps) {
  return (
    <span
      {...props}
      data-slot="truncated-path"
      className={cn("flex min-w-0 overflow-hidden", className)}
    >
      {directory && (
        <span
          className={cn("min-w-0 shrink truncate text-left [direction:rtl]", directoryClassName)}
        >
          <bdi dir="ltr">{directory}</bdi>
        </span>
      )}
      <span className={cn("max-w-full min-w-0 shrink-0 truncate", filenameClassName)}>
        {directory ? `${separator}${filename}` : filename}
      </span>
    </span>
  );
}
