import { useMediaQuery } from "@/hooks/useMediaQuery";
import { realmGroupingFor, type RealmGrouping } from "@/lib/federation/workspace-realm";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";

/**
 * How this window's sidebar groups machines' projects, as a realm is told
 * it (`grouping`), for code in the window's own document: the window's
 * `useRealmRequests` and another node's workspace shown in the window's tree
 * (plan item 4005), which reads it here instead of from `realmShellStore`.
 */
export function useWindowGrouping(): RealmGrouping {
  const phoneLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const storedGrouping = useMachineViewStore((state) => state.grouping);
  const sortMode = useUIChromeStore((state) => state.environmentSortMode);
  return realmGroupingFor(sortMode, storedGrouping, phoneLayout);
}
