/**
 * Геометрия осей для графиков аналитики: деления, подписи, логарифмическая
 * шкала. Без React и без размеров экрана, поэтому легко проверяется тестами.
 */

export interface NiceTicks {
  ticks: number[];
  max: number;
}

const STEP_MULTIPLIERS = [1, 2, 2.5, 5] as const;
const MAX_DIVISIONS = 5;
const EPS = 1e-9;

/** Убирает хвосты плавающей запятой: 0.1 * 3 дало бы 0.30000000000000004. */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

function candidateSteps(span: number): number[] {
  const exponent = Math.floor(Math.log10(span));
  const steps: number[] = [];
  for (let e = exponent - 2; e <= exponent + 1; e += 1) {
    for (const m of STEP_MULTIPLIERS) steps.push(clean(m * 10 ** e));
  }
  return steps.sort((a, b) => a - b);
}

/**
 * Деления оси от нуля: шаг 1, 2, 2,5 или 5 на степень десяти, не больше пяти
 * делений. Пустой ряд даёт ось от 0 до 1.
 */
export function niceTicks(maxValue: number): NiceTicks {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { ticks: [0, 1], max: 1 };
  const step = candidateSteps(maxValue).find((s) => Math.ceil(maxValue / s - EPS) <= MAX_DIVISIONS);
  const safeStep = step ?? clean(maxValue / MAX_DIVISIONS);
  const count = Math.max(1, Math.ceil(maxValue / safeStep - EPS));
  const ticks = Array.from({ length: count + 1 }, (_, i) => clean(i * safeStep));
  return { ticks, max: ticks[ticks.length - 1] };
}

/**
 * Деления оси для диапазона не от нуля (доля чтения кэша). Границы
 * округляются до шага, поэтому график не прижимается к краям.
 */
export function rangeTicks(min: number, max: number): NiceTicks & { min: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return { ticks: [0, 1], min: 0, max: 1 };
  }
  const span = max - min;
  if (span <= 0) {
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 0.5;
    return rangeTicks(min - pad, max + pad);
  }
  const step =
    candidateSteps(span).find((s) => Math.ceil(span / s - EPS) <= MAX_DIVISIONS) ??
    clean(span / MAX_DIVISIONS);
  const lo = clean(Math.floor(min / step + EPS) * step);
  const hi = clean(Math.ceil(max / step - EPS) * step);
  const count = Math.max(1, Math.round((hi - lo) / step));
  const ticks = Array.from({ length: count + 1 }, (_, i) => clean(lo + i * step));
  return { ticks, min: ticks[0], max: ticks[ticks.length - 1] };
}

/** Лестница делений логарифмической оси: 0,1, 0,2, 0,5, 1, 2, 5, 10, 20, 50 и так далее. */
function logLadder(from: number, to: number): number[] {
  const out: number[] = [];
  const startExp = Math.floor(Math.log10(from)) - 1;
  const endExp = Math.ceil(Math.log10(to)) + 1;
  for (let e = startExp; e <= endExp; e += 1) {
    for (const m of [1, 2, 5]) out.push(clean(m * 10 ** e));
  }
  return out;
}

/**
 * Деления логарифмической оси окупаемости: 0,5×, 1×, 2×, 5×, 10×. Берутся
 * ближайшие деления вокруг диапазона, одно значение растягивается на соседей.
 */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.max(Math.min(min, max), 1e-6);
  const hi = Math.max(Math.max(min, max), lo);
  const ladder = logLadder(lo, hi);
  let loIndex = -1;
  for (let i = 0; i < ladder.length; i += 1) if (ladder[i] <= lo + EPS) loIndex = i;
  let hiIndex = ladder.findIndex((v) => v >= hi - EPS);
  if (loIndex < 0) loIndex = 0;
  if (hiIndex < 0) hiIndex = ladder.length - 1;
  if (hiIndex <= loIndex) {
    loIndex = Math.max(0, loIndex - 1);
    hiIndex = Math.min(ladder.length - 1, hiIndex + 1);
  }
  return ladder.slice(loIndex, hiIndex + 1);
}

/** Положение значения на логарифмической шкале от 0 до 1. */
export function logPosition(value: number, lo: number, hi: number): number {
  const v = Math.max(value, Number.MIN_VALUE);
  const span = Math.log(hi) - Math.log(lo);
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.log(v) - Math.log(lo)) / span));
}

/**
 * Какие столбцы подписать на оси X, не больше `maxLabels`. Первая подпись
 * всегда на первом столбце, шаг одинаковый.
 */
export function pickLabelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) return [];
  const limit = Math.max(1, maxLabels);
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / limit);
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  return out;
}

/** Часовой ряд: индексы первой точки и каждой полуночи UTC. */
export function dayStartIndices(isoHours: string[]): number[] {
  const out: number[] = [];
  isoHours.forEach((iso, i) => {
    const ms = Date.parse(iso);
    if (i === 0 || (!Number.isNaN(ms) && ms % 86_400_000 === 0)) out.push(i);
  });
  return out;
}

/** Не больше `maxLabels` индексов из готового списка, равномерно. */
export function thinIndices(indices: number[], maxLabels: number): number[] {
  if (indices.length <= maxLabels) return indices;
  const step = Math.ceil(indices.length / Math.max(1, maxLabels));
  return indices.filter((_, i) => i % step === 0);
}
