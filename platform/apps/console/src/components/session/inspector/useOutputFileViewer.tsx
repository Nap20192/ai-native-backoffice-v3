import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useApi } from "../../../lib/api";
import { OutputFileDialog, type OutputFile } from "./OutputFileDialog";
import { saveBlob, sessionOutputPath } from "./output-files";

/**
 * Окно файлов агента для одной сессии: открыть файл из списка или по имени
 * из ссылки в ответе агента, скачать файл. Файл берётся запросом консоли
 * (apiRaw), с beta-заголовком, входом и рабочим пространством.
 */
export interface OutputFileViewer {
  open: (file: OutputFile) => void;
  /** Ищет файл в списке сессии, чтобы знать размер, и открывает окно. */
  openByName: (filename: string) => void;
  download: (filename: string, loaded?: Blob) => Promise<void>;
  dialog: ReactNode;
}

export function useOutputFileViewer(sessionId: string): OutputFileViewer {
  const { api, apiRaw } = useApi();
  const [file, setFile] = useState<OutputFile | null>(null);
  // Номер последнего открытия. Ответ на более раннюю ссылку, закрытие окна
  // или другая сессия делают ожидающий ответ устаревшим.
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    setFile(null);
  }, [sessionId]);

  const open = useCallback((next: OutputFile) => {
    latest.current += 1;
    setFile(next);
  }, []);

  const close = useCallback(() => {
    latest.current += 1;
    setFile(null);
  }, []);

  const fetchFile = useCallback(
    async (filename: string) => (await apiRaw(sessionOutputPath(sessionId, filename), { quiet: true })).blob(),
    [apiRaw, sessionId],
  );

  const download = useCallback(
    async (filename: string, loaded?: Blob) => {
      try {
        saveBlob(loaded ?? (await fetchFile(filename)), filename);
      } catch {
        toast.error(`Не удалось скачать файл ${filename}`);
      }
    },
    [fetchFile],
  );

  const openByName = useCallback(
    (filename: string) => {
      const mine = ++latest.current;
      void (async () => {
        let list: OutputFile[];
        try {
          const page = await api<{ data?: OutputFile[] }>(
            `/v1/sessions/${encodeURIComponent(sessionId)}/outputs`,
            { quiet: true },
          );
          list = page.data ?? [];
        } catch {
          if (mine === latest.current) toast.error("Список файлов сессии не загрузился. Повторите попытку.");
          return;
        }
        if (mine !== latest.current) return;
        const hit = list.find((candidate) => candidate.filename === filename);
        if (hit) setFile(hit);
        else
          toast.error(
            `Файл ${filename} не найден среди файлов сессии. Если агент ещё работает, он появится после хода.`,
          );
      })();
    },
    [api, sessionId],
  );

  const dialog = (
    <OutputFileDialog
      file={file}
      fetchFile={fetchFile}
      onDownload={(name, blob) => void download(name, blob)}
      onClose={close}
    />
  );

  return { open, openByName, download, dialog };
}
