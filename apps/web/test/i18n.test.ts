/** Every piece of text the web app translates is translated, in every language. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { TRANSLATIONS, t } from '../src/i18n';

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'translations' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The English passed to `t(…)` or `mark(…)` as a literal, anywhere in the app. */
function used(): Set<string> {
  const keys = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b(?:t|mark)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      keys.add(match[1]!.replace(/\\'/g, "'"));
    }
  }
  return keys;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

suite('translations', () => {
  const keys = used();

  it('finds the text the app translates', () => {
    expect(keys.has('To review')).toBe(true);
    expect(keys.size).toBeGreaterThan(100);
  });

  for (const [language, table] of Object.entries(TRANSLATIONS)) {
    it(`has ${language} for every piece, with the same placeholders, and nothing stale`, () => {
      const missing = [...keys].filter((key) => table[key] === undefined);
      expect(missing).toEqual([]);
      const stale = Object.keys(table).filter((key) => !keys.has(key));
      expect(stale).toEqual([]);
      for (const key of keys) expect(placeholders(table[key]!)).toEqual(placeholders(key));
    });
  }

  it('fills placeholders, and shows English for text with no translation', () => {
    expect(t('Sign out {name}', { name: 'ann' })).toBe('Sign out ann');
    expect(t('Not a translated sentence')).toBe('Not a translated sentence');
  });
});
