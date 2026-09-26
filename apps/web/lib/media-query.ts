import { useCallback, useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint: the chat sidebar stops being a drawer at and above it. */
export const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

const serverSnapshot = () => false;

/** Whether `query` matches the viewport. False on the server and during hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
