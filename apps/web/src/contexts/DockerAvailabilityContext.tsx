import { createContext, useContext, type ReactNode } from "react";

const DockerAvailabilityContext = createContext(true);
const DockerAvailabilityReadyContext = createContext(true);

export function DockerAvailabilityProvider({
  available,
  ready = true,
  children,
}: {
  available: boolean;
  /** False until the initial probe has returned a result or failed. */
  ready?: boolean;
  children: ReactNode;
}) {
  return (
    <DockerAvailabilityReadyContext.Provider value={ready}>
      <DockerAvailabilityContext.Provider value={available}>
        {children}
      </DockerAvailabilityContext.Provider>
    </DockerAvailabilityReadyContext.Provider>
  );
}

/**
 * Whether Docker-backed UI may perform work. The default keeps isolated
 * component renders usable; the application root always supplies the live
 * daemon status.
 */
export function useDockerAvailability(): boolean {
  return useContext(DockerAvailabilityContext);
}

/** Whether creation defaults can be resolved against the initial Docker probe. */
export function useDockerAvailabilityReady(): boolean {
  return useContext(DockerAvailabilityReadyContext);
}
