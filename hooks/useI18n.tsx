"use client";

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { translateMessage } from "@/lib/i18n/format";
import { enLocale } from "@/lib/i18n/messages/en";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

interface I18nContextValue {
  locale: Locale;
  t: (key: string, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const messages = { en: enLocale.messages };

/** Provide English UI messages to client components. */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = "en";
    try {
      // An older release persisted zh-CN/zh-TW. Drop the obsolete preference.
      window.localStorage.removeItem("pi-locale");
    } catch {
      // Private browsing may make localStorage unavailable.
    }
  }, []);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage("en", key, messages, params), []);
  const value = useMemo<I18nContextValue>(() => ({ locale: "en", t }), [t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the current locale and English UI messages. */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
