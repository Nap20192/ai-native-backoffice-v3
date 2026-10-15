import { useEffect, useState } from "react";

/** Ширина телефона: до неё списки рисуются стопкой карточек (правило 13 DDC). */
export const PHONE_QUERY = "(max-width: 640px)";

function readPhone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/**
 * true, пока окно уже 641px. Без `matchMedia` (тесты, старые окружения)
 * считаем, что это не телефон: список остаётся таблицей.
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState<boolean>(readPhone);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  return phone;
}
