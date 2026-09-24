/** Supported UI language. */
export type Locale = "en";

/** Values interpolated into UI messages. */
export type TranslationParams = Record<string, string | number>;

/** UI messages for a language. */
export interface LocalePlugin {
  /** Language code. */
  id: string;
  /** Display name. */
  label: string;
  /** Messages keyed by stable identifier. */
  messages: Record<string, string>;
}
