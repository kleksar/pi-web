"use client";

import { createContext, useContext, useMemo } from "react";
import { translateMessage } from "@/lib/i18n/format";
import { enLocale } from "@/lib/i18n/messages/en";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

interface I18nContextValue {
  locale: Locale;
  t: (key: string, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const messages = { en: enLocale.messages };

/** Provide English UI messages to the demo. */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<I18nContextValue>(() => ({
    locale: "en",
    t: (key, params) => translateMessage("en", key, messages, params),
  }), []);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
