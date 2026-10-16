import { createContext } from "react";
import { defaultUrlTransform } from "react-markdown";

/**
 * Ссылки агента на свои файлы. В ответе агент пишет путь из VM, например
 * [отчёт](/mnt/session/outputs/отчёт.docx) или sandbox:/mnt/session/outputs/…
 * В консоли такой адрес никуда не ведёт. Страница сессии кладёт в контекст
 * функцию, которая открывает файл в окне просмотра, а Markdown превращает
 * такую ссылку в кнопку. Вне страницы сессии контекста нет, и ссылка
 * остаётся обычной.
 */
export const OutputLinkContext = createContext<((filename: string) => void) | null>(null);

const OUTPUT_HREF = /^(?:sandbox:|file:\/\/)?\/mnt\/session\/outputs\/(.+)$/;

/** Имя файла агента из адреса ссылки или null, если ссылка ведёт не на файл агента. */
export function outputFileFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = OUTPUT_HREF.exec(href);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * urlTransform для react-markdown: адреса файлов агента со схемами sandbox:
 * и file:// остаются, остальное проходит обычную проверку, и javascript:
 * по-прежнему вырезается.
 */
export function keepOutputUrl(url: string): string {
  return outputFileFromHref(url) !== null ? url : defaultUrlTransform(url);
}
