import { createContext, useContext, type ReactNode } from "react";
import type { Messages } from "./types";
import { ru } from "./ru";

interface I18nContextValue {
  t: Messages;
}

/** Консоль говорит только по-русски: словарь один и не меняется. */
const VALUE: I18nContextValue = { t: ru };

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext value={VALUE}>{children}</I18nContext>;
}

/**
 * Хук доступа к строкам интерфейса.
 *
 * ```tsx
 * const { t } = useI18n();
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
