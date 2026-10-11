import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

/** Selection also targets toolbar actions; only visible panes count as viewed. */
export function useVisibleEnvironmentId(): string | null {
  const selectedId = useUIStore((state) => state.selectedEnvironmentId);
  const tab = useUIStore((state) => state.projectBoardTab);
  const isHome = useEnvironmentStore((state) =>
    state.environments.some(
      (environment) => environment.id === selectedId && environment.projectHome,
    ),
  );
  return isHome && tab !== "home" ? null : selectedId;
}
