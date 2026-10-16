/**
 * Чистые функции про harness агента: id из конфигурации, запись блока `_oma`
 * при смене harness, совместимость с моделью и причина отказа, выбор модели
 * по умолчанию, группы для списка. Правила повторяют разделы 3 и 6 контракта
 * docs/plans/models-harness.md. Сети и React здесь нет.
 */
import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import {
  HARNESS_GROUP_LABELS,
  harnessLabel,
  type HarnessGroupKey,
} from "./harness-text";

type Config = Record<string, unknown>;

/** Что нужно знать о harness, чтобы записать его в агента. */
export type HarnessTarget = Pick<HarnessEntry, "id" | "runtime_harness" | "acp">;

export type Compatibility = { ok: true } | { ok: false; reason: string };

function asObject(value: unknown): Config | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Config)
    : undefined;
}

/**
 * Id harness агента. Совпадает с ключом аналитики сервера: `pi` для пустого
 * значения, `default` и `pi`; `ai-sdk`; `acp-proxy`; для `acp-sandbox` id
 * ACP-агента из `_oma.acp.agent.id`.
 */
export function harnessIdOf(config: unknown): string {
  const openma = asObject(asObject(config)?._oma);
  const raw = openma?.harness;
  if (raw === undefined || raw === null || raw === "" || raw === "default" || raw === "pi") {
    return "pi";
  }
  if (raw === "acp-sandbox") {
    const agent = asObject(asObject(openma?.acp)?.agent);
    const id = agent?.id;
    return typeof id === "string" && id !== "" ? id : "acp-sandbox";
  }
  return typeof raw === "string" ? raw : "pi";
}

/** Конфигурация агента или запись каталога запускает ACP-агента в песочнице. */
export function isAcpHarness(subject: unknown): boolean {
  const object = asObject(subject);
  if (!object) return false;
  if (object.runtime_harness === "acp-sandbox") return true;
  return asObject(object._oma)?.harness === "acp-sandbox";
}

export function harnessTargetOf(entry: HarnessEntry): HarnessTarget {
  return { id: entry.id, runtime_harness: entry.runtime_harness, acp: entry.acp };
}

function withoutEffortAndSpeed(model: unknown): unknown {
  const object = asObject(model);
  if (!object) return model;
  const next = { ...object };
  delete next.effort;
  delete next.speed;
  return next;
}

/**
 * Записывает harness в конфигурацию агента и возвращает копию.
 *
 * ACP: `_oma.harness = "acp-sandbox"` и блок `_oma.acp` из записи каталога, у
 * модели исчезают `effort` и `speed` (ACP-агенту они не передаются). Остальные
 * ключи `_oma` и модели не меняются.
 *
 * Встроенный цикл: если агент уже на нём, конфигурация остаётся как есть
 * (явный `pi` не трогаем). Иначе `_oma.harness` и `_oma.acp` убираются: при
 * изменении агента через `null`, при создании удалением ключей.
 */
export function applyHarness(
  config: Config,
  target: HarnessTarget,
  opts: { forUpdate: boolean },
): Config {
  const next = structuredClone(config);
  const openma: Config = { ...(asObject(next._oma) ?? {}) };

  if (target.runtime_harness === "acp-sandbox") {
    openma.harness = "acp-sandbox";
    if (target.acp) openma.acp = structuredClone(target.acp);
    if (next.model !== undefined) next.model = withoutEffortAndSpeed(next.model);
    next._oma = openma;
    return next;
  }

  if (harnessIdOf(config) === "pi") return next;
  if (opts.forUpdate) {
    openma.harness = null;
    openma.acp = null;
  } else {
    delete openma.harness;
    delete openma.acp;
  }
  if (Object.keys(openma).length > 0) next._oma = openma;
  else delete next._oma;
  return next;
}

type ProtocolOwner = Pick<HarnessEntry, "id" | "label" | "source" | "protocols">;

function protocolList(protocols: string[]): string {
  return protocols.join(" или ");
}

/**
 * Подходит ли модель к harness. Запись с протоколами `["*"]` берёт любую
 * модель. ACP-запись берёт модель, если их протоколы пересекаются. Причина
 * собрана по образцу guard сервера, чтобы форма и API говорили одно и то же.
 */
export function compatibility(entry: ProtocolOwner, option: ModelOption): Compatibility {
  if (entry.protocols.includes("*")) return { ok: true };
  if (option.protocols.some((protocol) => entry.protocols.includes(protocol))) {
    return { ok: true };
  }
  const head = `${harnessLabel(entry)} работает только с моделями с протоколом ${protocolList(entry.protocols)}, у модели ${option.handle}`;
  return {
    ok: false,
    reason:
      option.protocols.length > 0
        ? `${head}: ${option.protocols.join(", ")}`
        : `${head} нет протокола, который понимает прокси`,
  };
}

/** Причина, по которой модель выключена для выбранного harness. Без harness или при совместимости `null`. */
export function modelDisabledReason(
  option: ModelOption,
  entry: ProtocolOwner | undefined,
): string | null {
  if (!entry) return null;
  const result = compatibility(entry, option);
  return result.ok ? null : result.reason;
}

/**
 * Причина, по которой harness выключен в списке. Недоступная запись называет
 * причину сервера. Запись без единой совместимой модели называет, какая модель
 * нужна. Пока модели не загружены, совместимость не проверяется.
 */
export function harnessDisabledReason(
  entry: HarnessEntry,
  options: ModelOption[] | undefined,
): string | null {
  if (entry.status === "unavailable") {
    return entry.reason ?? "Недоступно на этом сервере";
  }
  if (!options || entry.protocols.includes("*")) return null;
  if (options.some((option) => compatibility(entry, option).ok)) return null;
  return `Нет подходящих моделей: нужна модель с протоколом ${protocolList(entry.protocols)}`;
}

/**
 * Модель для формы по умолчанию: совместимая карточка `is_default`, иначе
 * первая совместимая карточка, иначе первая совместимая встроенная модель.
 */
export function pickDefaultModel(
  options: ModelOption[],
  entry: ProtocolOwner | undefined,
): ModelOption | null {
  const compatible = entry
    ? options.filter((option) => compatibility(entry, option).ok)
    : options;
  const cards = compatible.filter((option) => option.source === "card");
  return (
    cards.find((option) => option.is_default) ??
    cards[0] ??
    compatible.find((option) => option.source === "builtin") ??
    null
  );
}

export interface HarnessGroup {
  key: HarnessGroupKey;
  label: string;
  entries: HarnessEntry[];
}

/**
 * Группы списка harness: готовые, непроверенные, недоступные встроенные и
 * свои карточки. Порядок внутри группы тот, в котором отдал сервер. Пустые
 * группы пропускаются.
 */
export function groupHarnessEntries(entries: HarnessEntry[]): HarnessGroup[] {
  const keyOf = (entry: HarnessEntry): HarnessGroupKey =>
    entry.source === "card" ? "own" : entry.status;
  const order: HarnessGroupKey[] = ["ready", "unverified", "unavailable", "own"];
  return order
    .map((key) => ({
      key,
      label: HARNESS_GROUP_LABELS[key],
      entries: entries.filter((entry) => keyOf(entry) === key),
    }))
    .filter((group) => group.entries.length > 0);
}

/** Запись каталога по id или `undefined`. */
export function findHarness(entries: HarnessEntry[] | undefined, id: string): HarnessEntry | undefined {
  return entries?.find((entry) => entry.id === id);
}

/** Модель каталога по handle или `undefined`. */
export function findModel(options: ModelOption[] | undefined, handle: string): ModelOption | undefined {
  return options?.find((option) => option.handle === handle);
}
