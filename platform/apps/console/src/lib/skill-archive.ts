import { unzipSync } from "fflate";

/** Файл версии навыка для карточки: текст или пометка «двоичный». */
export interface SkillArchiveFile {
  filename: string;
  content: string;
  encoding: "utf8" | "base64";
}

/**
 * Разбирает zip версии навыка из `/v1/skills/:id/versions/:version/content`.
 * Сервер кладёт файлы в одну папку верхнего уровня, её имя убираем, чтобы
 * пути читались как в самом навыке: `SKILL.md`, `scripts/run.py`. Текст в
 * UTF-8 показываем как есть, остальное помечаем двоичным без содержимого.
 * SKILL.md идёт первым, остальные по алфавиту.
 */
export function readSkillArchiveFiles(archive: Uint8Array): SkillArchiveFile[] {
  const entries = Object.entries(unzipSync(archive)).filter(
    ([path]) => path !== "" && !path.endsWith("/"),
  );
  const roots = new Set(entries.map(([path]) => path.split("/")[0]));
  const stripRoot = roots.size === 1 && entries.every(([path]) => path.includes("/"));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = entries.map(([path, bytes]): SkillArchiveFile => {
    const filename = stripRoot ? path.slice(path.indexOf("/") + 1) : path;
    try {
      return { filename, content: decoder.decode(bytes), encoding: "utf8" };
    } catch {
      return { filename, content: "", encoding: "base64" };
    }
  });
  return files.sort((a, b) => {
    if (a.filename === "SKILL.md") return -1;
    if (b.filename === "SKILL.md") return 1;
    return a.filename.localeCompare(b.filename);
  });
}
