import { useEffect, useState } from 'react';
import { de } from './translations/de';
import { es } from './translations/es';
import { fr } from './translations/fr';

/** The languages the web app speaks, each named in itself. */
export const LANGUAGES = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
} as const;

export type Language = keyof typeof LANGUAGES;

/**
 * Each language's text, keyed by the English it replaces. A missing entry shows
 * the English, so a page never shows a key; the test of translations makes sure
 * none is missing.
 */
export const TRANSLATIONS: Readonly<
  Record<Exclude<Language, 'en'>, Readonly<Record<string, string>>>
> = { de, fr, es };

const STORAGE_KEY = 'sheaf.web.language';
const CHANGED = 'sheaf:language';

function isLanguage(value: string | null): value is Language {
  return value !== null && Object.hasOwn(LANGUAGES, value);
}

/** The language picked here before, or the browser's own when it is one of ours. */
function initial(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // Storage refused: fall back to the browser's language.
  }
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
  for (const tag of languages) {
    const base = tag.slice(0, 2).toLowerCase();
    if (isLanguage(base)) return base;
  }
  return 'en';
}

let current: Language = typeof window === 'undefined' ? 'en' : initial();
// From the first paint, so a screen reader reads German text as German.
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function language(): Language {
  return current;
}

export function setLanguage(next: Language): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Kept for this visit only.
  }
  document.documentElement.lang = next;
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * `text` in the current language, with `{name}` filled from `values`. The
 * English is the key, so a page reads naturally in its source.
 */
export function t(text: string, values: Readonly<Record<string, string | number>> = {}): string {
  const translated = current === 'en' ? text : (TRANSLATIONS[current][text] ?? text);
  return translated.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/**
 * English kept in a constant and put through `t` where it is drawn. Returns it
 * unchanged; it marks the text for the test that every one is translated.
 */
export const mark = (text: string): string => text;

/** The current language, redrawing the component when it changes. */
export function useLanguage(): Language {
  const [value, setValue] = useState(current);
  useEffect(() => {
    const changed = () => setValue(current);
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, []);
  return value;
}
