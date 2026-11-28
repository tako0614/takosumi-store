/**
 * Bilingual (JA/EN) draft helpers for PublishPage.
 *
 * Keeps quick single-language publishing effortless (one shared value populates
 * both locales and stays synced across edits), while supporting independent
 * Japanese and English entries without losing either locale on edit or when
 * switching the UI language mid-form.
 */
import type { Locale } from "../../../spec/api.ts";
import type { LocalizedText } from "../../../spec/listing.ts";

export interface LocalizedDraft {
  readonly ja: string;
  readonly en: string;
  readonly split: boolean;
}

export function emptyLocalizedDraft(): LocalizedDraft {
  return { ja: "", en: "", split: false };
}

export function draftFromLocalized(text: LocalizedText): LocalizedDraft {
  const ja = text.ja.trim();
  const en = text.en.trim();
  if (ja && en && ja !== en) {
    return { ja: text.ja, en: text.en, split: true };
  }
  const single = text.ja.trim() ? text.ja : text.en;
  return { ja: single, en: single, split: false };
}

export function primaryText(draft: LocalizedDraft, uiLocale: Locale): string {
  return uiLocale === "ja" ? draft.ja : draft.en;
}

export function secondaryText(draft: LocalizedDraft, uiLocale: Locale): string {
  if (!draft.split) return "";
  return uiLocale === "ja" ? draft.en : draft.ja;
}

export function setPrimaryText(
  draft: LocalizedDraft,
  uiLocale: Locale,
  value: string,
): LocalizedDraft {
  if (!draft.split) {
    return { ja: value, en: value, split: false };
  }
  return uiLocale === "ja" ? { ...draft, ja: value } : { ...draft, en: value };
}

export function setSecondaryText(
  draft: LocalizedDraft,
  uiLocale: Locale,
  value: string,
): LocalizedDraft {
  if (value === "") {
    const primary = primaryText(draft, uiLocale);
    return { ja: primary, en: primary, split: false };
  }
  return uiLocale === "ja"
    ? { ja: draft.ja, en: value, split: true }
    : { ja: value, en: draft.en, split: true };
}

export function resolveLocalized(
  draft: LocalizedDraft,
  fallback = "",
): LocalizedText {
  const ja = draft.ja.trim();
  const en = draft.en.trim();
  const fb = fallback.trim();
  if (!draft.split) {
    const single = ja || en || fb;
    return { ja: single, en: single };
  }
  return {
    ja: ja || en || fb,
    en: en || ja || fb,
  };
}
