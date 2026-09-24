import { enLocale } from "./messages/en";
import type { LocalePlugin } from "./types";

const localePlugins: LocalePlugin[] = [enLocale];

/** Return a registered locale package, or undefined for unsupported locales. */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.find((plugin) => plugin.id === id);
}

/** Return supported locale ids in their stable display order. */
export function getSupportedLocales(): string[] {
  return localePlugins.map((plugin) => plugin.id);
}
