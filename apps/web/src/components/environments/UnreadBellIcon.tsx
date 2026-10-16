import { Bell, type LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

/** The amber bell that marks an environment with unseen agent activity. */
export function UnreadBellIcon({ className, ...props }: LucideProps) {
  return <Bell className={cn("shrink-0 fill-amber-400/20 text-amber-400", className)} {...props} />;
}
