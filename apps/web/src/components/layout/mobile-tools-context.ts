import { createContext } from "react";

/** Lets a nested chooser dismiss Tools after committing a selection. */
export const CloseMobileToolsContext = createContext<(() => void) | null>(null);
