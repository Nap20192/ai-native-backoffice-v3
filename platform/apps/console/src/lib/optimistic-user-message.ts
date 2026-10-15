import type { Event } from "./events";

/** Текст реплики из content user.message: текстовые блоки через перенос. */
export function userMessageText(content: Event["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Текст, который сервер сохраняет, когда пользователь отправил только изображения. */
export function attachmentOnlyText(count: number): string {
  return count === 1 ? "Прикреплено изображение." : "Прикреплены изображения.";
}

/** Реплика, которую консоль показывает сразу после отправки, не дожидаясь
 *  сервера. Старый сервер не присылает user.message в потоке, так что без неё
 *  реплика появилась бы только после перезагрузки страницы. */
export function createOptimisticUserEvent(localId: string, text: string, ts: string): Event {
  return {
    type: "user.message",
    id: localId,
    content: [{ type: "text", text }],
    ts,
  };
}

interface Entry {
  localId: string;
  text: string;
  /** id события на сервере: известен, когда POST принят. */
  serverId?: string;
}

/**
 * Реплики, показанные локально, чьё событие сервера консоль ещё не видела.
 * Запись живёт, пока не придёт её user.message из потока или сервер не
 * поставит реплику в очередь. Старый сервер user.message в поток не шлёт,
 * тогда запись просто остаётся до смены сессии.
 */
export class OptimisticUserMessages {
  private entries: Entry[] = [];
  private counter = 0;

  get size(): number {
    return this.entries.length;
  }

  add(text: string): string {
    this.counter += 1;
    const localId = `local-user-${this.counter}-${Date.now().toString(36)}`;
    this.entries.push({ localId, text });
    return localId;
  }

  /** POST принят: запоминаем id события на сервере. */
  accept(localId: string, serverId: string): boolean {
    const entry = this.entries.find((e) => e.localId === localId);
    if (!entry) return false;
    entry.serverId = serverId;
    return true;
  }

  /** Пришёл user.message сервера. Сначала ищем запись по id, затем по тексту
   *  среди ещё не принятых: принятая под другим id принадлежит другому
   *  событию. */
  claimForEvent(serverId: string | undefined, text: string): string | undefined {
    return this.take(
      (e) => (serverId !== undefined && e.serverId === serverId) ||
        (e.serverId === undefined && e.text === text),
      serverId,
    );
  }

  /** Сервер взял реплику в очередь (system.user_message_pending): очередь
   *  рисует её сама, локальная копия не нужна. Ищем по id, затем по тексту. */
  claimForPending(serverId: string | undefined, text: string): string | undefined {
    return this.take((e) => e.text === text, serverId);
  }

  release(localId: string): boolean {
    const index = this.entries.findIndex((e) => e.localId === localId);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  clear(): void {
    this.entries = [];
  }

  private take(byText: (entry: Entry) => boolean, serverId: string | undefined): string | undefined {
    let index = serverId === undefined ? -1 : this.entries.findIndex((e) => e.serverId === serverId);
    if (index < 0) index = this.entries.findIndex(byText);
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    return entry?.localId;
  }
}
