/**
 * Цвета рядов графиков аналитики.
 *
 * Классы Tailwind записаны целыми строками, чтобы сборка нашла их в исходниках.
 * Цвета берутся из шкал DDC (brand, sky, amber, rose, ink). В тёмной теме
 * каждый цвет на ступень светлее, иначе ряд сливается с поверхностью.
 * Цвет ключа выбирается по хешу, поэтому одна модель одного цвета на всех
 * страницах.
 */

export interface SeriesColor {
  /** Заливка элемента: квадрат легенды, столбец. */
  bg: string;
  /** Заливка SVG-фигуры. */
  fill: string;
  /** Линия SVG. */
  stroke: string;
}

export const SERIES_PALETTE: readonly SeriesColor[] = [
  { bg: "bg-brand-600 dark:bg-brand-500", fill: "fill-brand-600 dark:fill-brand-500", stroke: "stroke-brand-600 dark:stroke-brand-500" },
  { bg: "bg-sky-500 dark:bg-sky-400", fill: "fill-sky-500 dark:fill-sky-400", stroke: "stroke-sky-500 dark:stroke-sky-400" },
  { bg: "bg-amber-500 dark:bg-amber-400", fill: "fill-amber-500 dark:fill-amber-400", stroke: "stroke-amber-500 dark:stroke-amber-400" },
  { bg: "bg-rose-500 dark:bg-rose-400", fill: "fill-rose-500 dark:fill-rose-400", stroke: "stroke-rose-500 dark:stroke-rose-400" },
  { bg: "bg-ink-500 dark:bg-ink-400", fill: "fill-ink-500 dark:fill-ink-400", stroke: "stroke-ink-500 dark:stroke-ink-400" },
  { bg: "bg-brand-300 dark:bg-brand-200", fill: "fill-brand-300 dark:fill-brand-200", stroke: "stroke-brand-300 dark:stroke-brand-200" },
  { bg: "bg-sky-300 dark:bg-sky-200", fill: "fill-sky-300 dark:fill-sky-200", stroke: "stroke-sky-300 dark:stroke-sky-200" },
  { bg: "bg-amber-300 dark:bg-amber-200", fill: "fill-amber-300 dark:fill-amber-200", stroke: "stroke-amber-300 dark:stroke-amber-200" },
];

export type TokenTypeKey = "cache_read" | "cache_write" | "output" | "input";

/** Типы токенов закреплены: чтение кэша sky, запись amber, выход brand, вход ink. */
export const TOKEN_TYPE_COLORS: Record<TokenTypeKey, SeriesColor> = {
  cache_read: SERIES_PALETTE[1],
  cache_write: SERIES_PALETTE[2],
  output: SERIES_PALETTE[0],
  input: { bg: "bg-ink-400 dark:bg-ink-300", fill: "fill-ink-400 dark:fill-ink-300", stroke: "stroke-ink-400 dark:stroke-ink-300" },
};

/** Ряд «Остальные» для хвоста сверх семи рядов. */
export const OTHER_COLOR: SeriesColor = {
  bg: "bg-ink-300 dark:bg-ink-600",
  fill: "fill-ink-300 dark:fill-ink-600",
  stroke: "stroke-ink-300 dark:stroke-ink-600",
};

/** Сколько рядов рисуется отдельно, остальные складываются в «Остальные». */
export const MAX_NAMED_SERIES = 7;

/** FNV-1a на 32 бита без знака. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Цвет ключа по хешу. Один ключ всегда получает один цвет. */
export function colorForKey(key: string): SeriesColor {
  return SERIES_PALETTE[fnv1a(key) % SERIES_PALETTE.length];
}

/**
 * Цвета для набора ключей одного графика. Ключ берёт свой цвет по хешу, а при
 * совпадении внутри графика следующий свободный.
 */
export function assignSeriesColors(keys: readonly string[]): Map<string, SeriesColor> {
  const used = new Set<number>();
  const out = new Map<string, SeriesColor>();
  for (const key of keys) {
    if (out.has(key)) continue;
    const preferred = fnv1a(key) % SERIES_PALETTE.length;
    let index = preferred;
    if (used.size < SERIES_PALETTE.length) {
      while (used.has(index)) index = (index + 1) % SERIES_PALETTE.length;
    }
    used.add(index);
    out.set(key, SERIES_PALETTE[index]);
  }
  return out;
}

/** Делит ряды на видимые и хвост, который уходит в «Остальные». */
export function foldTail<T>(items: readonly T[], maxHead: number): { head: T[]; tail: T[] } {
  return { head: items.slice(0, maxHead), tail: items.slice(maxHead) };
}
