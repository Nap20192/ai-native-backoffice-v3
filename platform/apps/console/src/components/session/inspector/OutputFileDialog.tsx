import { useEffect, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "../../Modal";
import { formatBytesRu } from "../format-ru";
import {
  MAX_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  officeAppFor,
  outputBlobType,
  outputPreviewKind,
} from "./output-files";

/**
 * Окно файла агента: PDF и картинки показываются прямо в консоли, текст
 * (и HTML как текст) идёт в моноширинном блоке. Офисные и прочие файлы
 * не показываются: окно предлагает их скачать и не грузит файл заранее.
 */

export interface OutputFile {
  filename: string;
  size_bytes: number;
}

export interface OutputFileDialogProps {
  /** Открытый файл; null закрывает окно. */
  file: OutputFile | null;
  /** Берёт файл запросом консоли, с заголовками и входом. */
  fetchFile: (filename: string) => Promise<Blob>;
  /** Сохраняет файл на диск; blob передаётся, если файл уже загружен. */
  onDownload: (filename: string, blob?: Blob) => void;
  onClose: () => void;
}

type PreviewState =
  | { phase: "skip" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; blob: Blob; url: string | null; text: string | null };

const OUTPUT_DIR = "/mnt/session/outputs/";

export function OutputFileDialog({ file, fetchFile, onDownload, onClose }: OutputFileDialogProps) {
  const kind = file ? outputPreviewKind(file.filename, file.size_bytes) : "none";
  const [state, setState] = useState<PreviewState>({ phase: "skip" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!file || kind === "none") {
      setState({ phase: "skip" });
      return;
    }
    let alive = true;
    let url: string | null = null;
    setState({ phase: "loading" });
    fetchFile(file.filename).then(
      async (blob) => {
        if (kind === "text") {
          const text = await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text();
          if (alive) setState({ phase: "ready", blob, url: null, text });
          return;
        }
        if (!alive) return;
        const type = outputBlobType(file.filename);
        const typed = type === null || blob.type === type ? blob : new Blob([blob], { type });
        url = URL.createObjectURL(typed);
        setState({ phase: "ready", blob, url, text: null });
      },
      () => {
        if (alive) setState({ phase: "error" });
      },
    );
    return () => {
      alive = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [file, kind, fetchFile, attempt]);

  const wide = kind === "pdf" || kind === "image";
  return (
    <Modal
      open={file !== null}
      onClose={onClose}
      title={file?.filename ?? ""}
      subtitle={file ? `${OUTPUT_DIR}${file.filename} · ${formatBytesRu(file.size_bytes)}` : undefined}
      maxWidth={wide ? "max-w-5xl" : kind === "text" ? "max-w-3xl" : "max-w-md"}
      footer={
        file ? (
          <Button onClick={() => onDownload(file.filename, state.phase === "ready" ? state.blob : undefined)}>
            <DownloadIcon aria-hidden="true" />
            Скачать
          </Button>
        ) : null
      }
    >
      {file ? <PreviewBody file={file} kind={kind} state={state} onRetry={() => setAttempt((n) => n + 1)} /> : null}
    </Modal>
  );
}

function PreviewBody({
  file,
  kind,
  state,
  onRetry,
}: {
  file: OutputFile;
  kind: ReturnType<typeof outputPreviewKind>;
  state: PreviewState;
  onRetry: () => void;
}) {
  if (kind === "none") {
    const app = officeAppFor(file.filename);
    const text =
      file.size_bytes > MAX_PREVIEW_BYTES
        ? `Файл больше ${MAX_PREVIEW_BYTES / 1024 / 1024} МБ, в консоли он не показывается. Скачайте его.`
        : app
          ? `В консоли этот формат не показывается. Скачайте файл и откройте его в ${app}.`
          : "В консоли этот формат не показывается. Скачайте файл.";
    return <p className="text-sm text-ddc-text-muted">{text}</p>;
  }
  if (state.phase === "loading" || state.phase === "skip") {
    return (
      <p role="status" aria-busy="true" className="text-sm text-ddc-text-muted">
        Загрузка файла…
      </p>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ddc-text-muted">Файл не загрузился.</p>
        <Button variant="outline" size="xs" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    );
  }
  if (kind === "pdf" && state.url !== null) {
    return (
      <iframe
        title={`Просмотр ${file.filename}`}
        src={state.url}
        className="h-[70vh] w-full rounded-md border border-ddc-border"
      />
    );
  }
  if (kind === "image" && state.url !== null) {
    return <img src={state.url} alt={file.filename} className="mx-auto max-h-[70vh] max-w-full object-contain" />;
  }
  const cut = state.blob.size > MAX_TEXT_PREVIEW_BYTES;
  return (
    <div className="space-y-2">
      {cut ? (
        <p className="text-xs text-ddc-text-muted">
          {`Показаны первые ${MAX_TEXT_PREVIEW_BYTES / 1024} КБ из ${formatBytesRu(state.blob.size)}. Целиком файл можно скачать.`}
        </p>
      ) : null}
      <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-ddc-surface p-3 font-mono text-xs">
        {state.text}
      </pre>
    </div>
  );
}
