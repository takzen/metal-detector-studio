"use client";

import { useEffect, useState } from "react";

const PREFIX = "mds:"; // metal-detector-studio settings namespace

function read<T>(key: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined; // corrupt JSON / privacy mode — fall back to default
  }
}

/**
 * `useState` that persists to `localStorage`.
 *
 * SSR-safe: the first render (server + client) always uses `initial`, so the
 * markup matches and there is no hydration mismatch. The stored value, if any,
 * is loaded on mount; only after that do changes get written back (so the
 * default never clobbers a saved value during the initial commit).
 *
 * Values must be JSON-serialisable — use arrays instead of Set/Map.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  // Load once on mount (client only). Setting state here is intentional: we
  // sync from an external store (localStorage) that isn't available during SSR,
  // which is the only way to avoid a hydration mismatch (server renders the
  // default, client adopts the stored value after paint).
  useEffect(() => {
    const stored = read<T>(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load from localStorage on mount
    if (stored !== undefined) setValue(stored);
    setHydrated(true);
  }, [key]);

  // Persist on change, but not until after the stored value has been loaded.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* quota exceeded / privacy mode — ignore */
    }
  }, [key, value, hydrated]);

  return [value, setValue] as const;
}
