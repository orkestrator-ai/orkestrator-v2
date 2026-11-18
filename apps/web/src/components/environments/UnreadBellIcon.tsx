import { Bell, type LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

/** The shared amber bell for unread activity and waiting environments. */
export function UnreadBellIcon({ className, ...props }: LucideProps) {
  return <Bell className={cn("shrink-0 fill-amber-400/20 text-amber-400", className)} {...props} />;
}
