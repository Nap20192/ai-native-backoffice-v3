/**
 * Файлы, которые агент сохранил в /mnt/session/outputs/: адрес в API, вид
 * просмотра в консоли и сохранение на диск. Ссылка браузера не передаёт
 * anthropic-beta и рабочее пространство, сервер на неё отвечает 400. Поэтому
 * файл всегда берётся запросом консоли, а на диск уходит через blob.
 */

export type OutputPreviewKind = "pdf" | "image" | "text" | "none";

/** Сколько текста показывать в окне: длинные журналы обрезаются. */
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

/** Файлы больше этого предела консоль не показывает, только скачивает. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml", "xml", "toml", "ini",
  "py", "js", "ts", "sql", "sh", "css", "html", "htm", "svg",
]);

// Тип задаём сами: PDF и картинку браузер покажет только с верным типом, а
// файл с чужим содержимым под таким именем не станет страницей. SVG здесь
// нет: это документ со скриптами, и его blob, открытый в новой вкладке,
// выполнил бы скрипт агента от имени консоли. SVG показывается текстом.
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const OFFICE_APPS: Record<string, string> = {
  docx: "Word",
  doc: "Word",
  xlsx: "Excel",
  xls: "Excel",
  pptx: "PowerPoint",
  ppt: "PowerPoint",
  odt: "LibreOffice",
  ods: "LibreOffice",
  odp: "LibreOffice",
};

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** Адрес файла в API сессии. */
export function sessionOutputPath(sessionId: string, filename: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(filename)}`;
}

/** Как показать файл в консоли. HTML и SVG идут как текст: страница агента не открывается. */
export function outputPreviewKind(filename: string, sizeBytes = 0): OutputPreviewKind {
  if (sizeBytes > MAX_PREVIEW_BYTES) return "none";
  const ext = extension(filename);
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_TYPES) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "none";
}

/** Тип для blob просмотра: PDF и растровые картинки. Для остального null. */
export function outputBlobType(filename: string): string | null {
  const ext = extension(filename);
  if (ext === "pdf") return "application/pdf";
  return IMAGE_TYPES[ext] ?? null;
}

/** Программа, в которой открыть офисный файл, или null. */
export function officeAppFor(filename: string): string | null {
  return OFFICE_APPS[extension(filename)] ?? null;
}

/** Сохраняет blob на диск под именем файла. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Адрес живёт ещё секунду: браузер успевает начать скачивание.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
