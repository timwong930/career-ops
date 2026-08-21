"use client";

import { useEffect } from "react";

const STORAGE_KEY = "career-ops:config";

/**
 * A few older client surfaces still read `career-ops:config.cliId` while the
 * authoritative AI selection now lives server-side in data/web-ai.json.
 * Keep those readers in sync until they are migrated individually.
 */
export function AiProviderBridge() {
  useEffect(() => {
    let cancelled = false;

    async function sync() {
      try {
        const response = await fetch("/api/ai/config", { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        const config = data?.config;
        if (!config) return;

        let current: Record<string, unknown> = {};
        try {
          current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        } catch {
          current = {};
        }

        const next = {
          ...current,
          mode: config.mode,
          cliId:
            config.mode === "endpoint"
              ? "omlx"
              : typeof config.cliId === "string"
                ? config.cliId
                : current.cliId,
        };

        const encoded = JSON.stringify(next);
        if (localStorage.getItem(STORAGE_KEY) !== encoded) {
          localStorage.setItem(STORAGE_KEY, encoded);
          // The native storage event does not fire in the tab that performed the
          // write. Dispatch one so AssistantConsole re-reads immediately.
          window.dispatchEvent(new Event("storage"));
        }
      } catch {
        /* best-effort compatibility bridge */
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
