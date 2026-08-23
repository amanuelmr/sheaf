/**
 * Design tokens. An 8pt spacing scale, one accent, and restraint about everything
 * else — this is a tool for handling important documents, not a dashboard.
 *
 * Dark mode is a designed palette rather than an inversion: the surfaces are warm
 * near-blacks, and text stays comfortably readable against them.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export const type = {
  title: { fontSize: 28, fontWeight: '600' },
  heading: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 16, fontWeight: '400' },
  label: { fontSize: 15, fontWeight: '500' },
  meta: { fontSize: 13, fontWeight: '400' },
  mono: { fontSize: 12, fontWeight: '400', fontFamily: 'Courier' },
} as const;

export interface Palette {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  ok: string;
  waiting: string;
  danger: string;
  shutterChrome: string;
}

const light: Palette = {
  background: '#faf9f7',
  surface: '#ffffff',
  surfaceRaised: '#f3f1ee',
  border: '#e3e0da',
  text: '#1c1b19',
  textMuted: '#6c6862',
  accent: '#1f5f4b',
  accentText: '#ffffff',
  ok: '#1f6b45',
  waiting: '#8a5a15',
  danger: '#9b2c22',
  shutterChrome: '#111110',
};

const dark: Palette = {
  background: '#141312',
  surface: '#1d1c1a',
  surfaceRaised: '#262421',
  border: '#35322e',
  text: '#f2f0ec',
  textMuted: '#a39d95',
  accent: '#5fd0a6',
  accentText: '#0e1a15',
  ok: '#68c99a',
  waiting: '#e0b264',
  danger: '#e58177',
  shutterChrome: '#000000',
};

export const palettes = { light, dark } as const;

/** Minimum touch target the spec asks for (§10.2). */
export const TOUCH_TARGET = 44;
