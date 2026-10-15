import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Locale, Messages } from "./types";
import { en } from "./en";
import { ru } from "./ru";
import { zhCN } from "./zh-CN";

const dictionaries: Record<Locale, Messages> = {
  ru,
  en,
  "zh-CN": zhCN,
};

const STORAGE_KEY = "oma-locale";

/** Язык по умолчанию: русский. Язык браузера не учитывается. */
export const DEFAULT_LOCALE: Locale = "ru";

function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(dictionaries, value)
  );
}

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Хранилище недоступно: остаётся язык по умолчанию.
  }
  return DEFAULT_LOCALE;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Выбор действует до перезагрузки страницы.
    }
    setLocaleState(next);
  }, []);

  // Атрибут lang нужен читалкам с экрана и подбору шрифта.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useMemo(() => dictionaries[locale], [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

/**
 * Хук доступа к переводам и выбору языка.
 *
 * ```tsx
 * const { t, locale, setLocale } = useI18n();
 * return <h1>{t.nav.dashboard}</h1>;
 * ```
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an <I18nProvider>");
  }
  return ctx;
}

/** Языки для переключателя в меню профиля. */
export const AVAILABLE_LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: "ru", label: "Русский", flag: "RU" },
  { value: "en", label: "English", flag: "EN" },
  { value: "zh-CN", label: "简体中文", flag: "中" },
];
