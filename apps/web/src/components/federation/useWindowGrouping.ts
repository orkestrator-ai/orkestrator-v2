import { useMediaQuery } from "@/hooks/useMediaQuery";
import { windowGroupingFor, type WindowGrouping } from "@/lib/federation/window-grouping";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";

/**
 * How this window's sidebar groups machines' projects, for another node's
 * workspace shown in the window's tree (plan item 4005): its coordinator gate
 * reads it here (`windowGroupingFor`).
 */
export function useWindowGrouping(): WindowGrouping {
  const phoneLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const storedGrouping = useMachineViewStore((state) => state.grouping);
  const sortMode = useUIChromeStore((state) => state.environmentSortMode);
  return windowGroupingFor(sortMode, storedGrouping, phoneLayout);
}
