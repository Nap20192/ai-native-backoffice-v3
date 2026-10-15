export class AnalyticsError extends Error {
  constructor(message: string, public status: 400 | 404 | 501 = 400) { super(message); }
}
export const DAY = 86400000;
export const HOUR = 3600000;
export const iso = (time: number) => new Date(time).toISOString();
export const ratio = (a: number, b: number) => b ? Math.round(a / b * 10000) / 10000 : null;
export interface Cursor { e: number; i: string }
export const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(parsed.e) || parsed.e < 0 || typeof parsed.i !== 'string' || !parsed.i || parsed.i.length > 200) throw Error();
    return {e:parsed.e, i:parsed.i};
  } catch { throw new AnalyticsError('Курсор журнала неверен.'); }
}
export type GroupBy = 'model' | 'agent' | 'harness' | 'card' | 'environment' | 'speed' | 'none';
export type Metric = 'itpm' | 'otpm' | 'rpm';
export type Filters = Record<'agent_id' | 'model' | 'harness' | 'card_id', string[]>;
export interface AnalyticsQuery {
  from: string; to: string; fromMs: number; toMs: number; bucket: 'day' | 'hour'; group_by: GroupBy;
  filters: Filters; format: 'json' | 'csv'; limit: number; cursor?: Cursor; session_id?: string; status?: 'ok' | 'error'; q?: string;
  metric: Metric; by: 'agent' | 'session';
}
function choice<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw new AnalyticsError('Значение параметра неверно.');
  return value as T;
}
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || iso(Date.parse(value)).slice(0,10) !== value) throw new AnalyticsError('Дата должна быть в формате ГГГГ-ММ-ДД.');
  return value;
}
export function parseQuery(raw: Record<string, string | undefined>, route: 'usage' | 'cache' | 'model_calls' | 'facets' | 'limit', now = Date.now()): AnalyticsQuery {
  const today = iso(now).slice(0,10);
  const from = date(raw.from ?? iso(Date.parse(today) - 29 * DAY).slice(0,10));
  const requestedTo = date(raw.to ?? today);
  const to = requestedTo > today ? today : requestedTo;
  const bucket = choice(raw.bucket, ['day','hour'], 'day');
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  if (days < 1) throw new AnalyticsError('Начало периода позже конца.');
  if (days > (bucket === 'hour' ? 7 : 92)) throw new AnalyticsError(bucket === 'hour' ? 'Период не больше 7 дней.' : 'Период не больше 92 дней.');
  const filters: Filters = {agent_id:[], model:[], harness:[], card_id:[]};
  for (const key of Object.keys(filters) as (keyof Filters)[]) {
    const list = raw[key] === undefined ? [] : raw[key]!.split(',');
    if (list.length > 50 || list.some(v => !v || v.length > 200)) throw new AnalyticsError('В фильтре до 50 значений длиной до 200 знаков.');
    filters[key] = [...new Set(list)];
  }
  const group_by = choice(raw.group_by, route === 'cache' ? ['model','agent'] : ['model','agent','harness','card','environment','speed','none'], 'model');
  const format = choice(raw.format, ['json','csv'], 'json');
  const metric = choice(raw.metric, ['itpm','otpm','rpm'], 'itpm');
  const by = choice(raw.by, ['agent','session'], 'agent');
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AnalyticsError('Размер страницы от 1 до 200.');
  const status = raw.status === undefined ? undefined : choice(raw.status, ['ok','error'], 'ok');
  if (raw.q !== undefined && (raw.q.length < 4 || raw.q.length > 200)) throw new AnalyticsError('ID вызова должен содержать от 4 до 200 знаков.');
  if (raw.session_id !== undefined && (!raw.session_id || raw.session_id.length > 200)) throw new AnalyticsError('ID сессии неверен.');
  return {from,to,fromMs:Date.parse(from),toMs:Date.parse(to)+DAY,bucket,group_by,filters,format,metric,by,limit,status,q:raw.q,session_id:raw.session_id,cursor:raw.cursor === undefined ? undefined : decodeCursor(raw.cursor)};
}
export const LIMIT_FIELDS = ['requests_per_minute','input_tokens_per_minute','output_tokens_per_minute'] as const;
export type LimitsValues = Record<typeof LIMIT_FIELDS[number], number | null>;
export function parseLimitsBody(value: unknown): LimitsValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AnalyticsError('Укажите три лимита карточки.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 3 || Object.keys(body).some(key => !LIMIT_FIELDS.includes(key as typeof LIMIT_FIELDS[number]))) throw new AnalyticsError('Укажите только три лимита карточки.');
  const labels = ['Лимит запросов в минуту','Лимит токенов входа в минуту','Лимит токенов выхода в минуту'];
  LIMIT_FIELDS.forEach((key,i) => {const n = body[key]; if (n !== null && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000000000)) throw new AnalyticsError(`${labels[i]}: целое число от 1 до 1 000 000 000 или пусто.`);});
  return body as LimitsValues;
}
