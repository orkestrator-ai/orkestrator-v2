import type { ComponentType } from "react";
import { SquareArrowRight, SquareDot, SquareMinus, SquarePlus, SquareSlash } from "lucide-react";
import type { ChangeFileStatus } from "@orkestrator/protocol/change-resources";

/** The icon and colour of each file status, shared by the file list and tree. */
export const FILE_STATUS_ICONS: Record<
  ChangeFileStatus,
  { icon: ComponentType<{ className?: string }>; className: string }
> = {
  added: { icon: SquarePlus, className: "text-success" },
  modified: { icon: SquareDot, className: "text-amber-400" },
  deleted: { icon: SquareMinus, className: "text-failure" },
  renamed: { icon: SquareArrowRight, className: "text-sky-400" },
  copied: { icon: SquareArrowRight, className: "text-sky-400" },
  "mode-changed": { icon: SquareSlash, className: "text-muted-foreground" },
  "type-changed": { icon: SquareSlash, className: "text-muted-foreground" },
  unknown: { icon: SquareDot, className: "text-muted-foreground" },
};
