import { enLocale } from "./messages/en";
import type { LocalePlugin } from "./types";

const localePlugins: LocalePlugin[] = [enLocale];

/** Return a registered locale, if one exists for the ID. */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.find((plugin) => plugin.id === id);
}

/** Return the supported locales in display order. */
export function getSupportedLocales(): string[] {
  return localePlugins.map((plugin) => plugin.id);
}
