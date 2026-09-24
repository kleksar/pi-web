/** Built-in interface language. */
export type Locale = "en";

/** Simple interpolation parameters for UI text. */
export type TranslationParams = Record<string, string | number>;

/** A registered locale package. */
export interface LocalePlugin {
  /** Unique locale id. */
  id: string;
  /** Human-readable display name. */
  label: string;
  /** Messages indexed by stable keys. */
  messages: Record<string, string>;
}
