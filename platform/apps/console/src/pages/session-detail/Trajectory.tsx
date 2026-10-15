import {
  rewardHeadline,
  outcomeToStatusTone,
  type Trajectory,
} from "../../lib/trajectory";
import { StatusPill } from "../../components/Badge";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EMPTY_VALUE, formatDateTimeRu } from "../../components/session/format-ru";

/**
 * Траектория на странице сессии.
 *
 * Три части:
 *   - `TrajectoryOutcomeChip`: значок «Итог: X». Скрыт, пока траектория
 *     грузится, при ошибке и пока агент ещё работает.
 *   - `TrajectoryRewardChip`: парный значок с оценкой проверяющего. В
 *     подсказке id проверяющего и время расчёта.
 *   - `TrajectoryViewerModal`: окно с обоими значками, отформатированным
 *     JSON и кнопкой скачивания. Его открывает пункт «Траектория» в меню
 *     «⋮» шапки сессии. Проекции Anthropic Messages, Inspect AI и OTel
 *     появятся позже.
 *
 * Вынесено из SessionDetail, чтобы основная страница занималась потоком
 * событий и чатом.
 */

/** Итог траектории по-русски. Сырые значения (`success`, `failure`) в
 *  интерфейс не выводятся. */
const OUTCOME_LABEL: Record<string, string> = {
  success: "успешно",
  failure: "неудача",
  timeout: "превышено время",
  interrupted: "прервано",
  running: "выполняется",
};

export function TrajectoryOutcomeChip({
  trajectory,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  if (trajectory.outcome === "running") return null;
  const tone = outcomeToStatusTone(trajectory.outcome);
  return (
    <StatusPill
      status={tone}
      label={`Итог: ${OUTCOME_LABEL[trajectory.outcome] ?? trajectory.outcome}`}
    />
  );
}

/** Reward chip rendered in the session header strip. Pure read-out of
 *  the verifier output; tooltip shows verifier_id for debugging. */
export function TrajectoryRewardChip({
  trajectory,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (!trajectory || trajectory === "loading" || trajectory === "error") return null;
  const r = trajectory.reward;
  if (!r) return null;
  const headline = rewardHeadline(r);
  const isPass = r.final_reward >= 0.99;
  const isFail = r.final_reward <= 0;
  // Reuse StatusPill tone tokens so the visual language stays consistent
  // with the outcome chip next to it (success = same green, failure = red).
  const tone = isPass ? "completed" : isFail ? "errored" : "neutral";
  const titleParts = [
    `Оценка: ${r.final_reward.toFixed(4).replace(".", ",")}`,
    r.verifier_id ? `проверяющий: ${r.verifier_id}` : null,
    r.computed_at ? `рассчитано: ${formatDateTimeRu(r.computed_at)}` : null,
  ].filter(Boolean) as string[];
  const headlineRu = headline === "–" ? EMPTY_VALUE : headline;
  return (
    <span title={titleParts.join(" · ")}>
      <StatusPill status={tone} label={`Оценка: ${headlineRu}`} />
    </span>
  );
}

/** Окно просмотра траектории: отформатированный JSON и кнопка скачивания.
 *  Скачивание идёт через blob-адрес в памяти, запроса к серверу нет. */
export function TrajectoryViewerModal({
  open,
  onClose,
  sessionId,
  trajectory,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error";
  const json = ready ? JSON.stringify(trajectory, null, 2) : "";

  function download() {
    if (!ready) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trajectory-${sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Траектория"
      subtitle={ready ? `${trajectory.trajectory_id} · сессия ${sessionId}` : `Сессия ${sessionId}`}
      maxWidth="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Закрыть</Button>
          <Button onClick={download} disabled={!ready}>Скачать JSON</Button>
        </>
      }
    >
      {trajectory === "loading" && (
        <div className="flex items-center gap-2 text-sm text-ddc-text-muted" role="status">
          <Spinner />
          Загрузка траектории…
        </div>
      )}
      {trajectory === "error" && (
        <div className="callout-danger" role="alert">
          Траектория недоступна. Возможно, в сессии ещё нет событий или недоступен
          исполнитель в песочнице. Обновите страницу, чтобы повторить попытку.
        </div>
      )}
      {trajectory === undefined && (
        <div className="text-sm text-ddc-text-muted">Траектория ещё не загружена.</div>
      )}
      {ready && (
        <>
          {/* Итог и оценка стояли в шапке сессии. В шапке образца для них
              места нет, поэтому они живут здесь, рядом с исходными данными. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 empty:hidden">
            <TrajectoryOutcomeChip trajectory={trajectory} />
            <TrajectoryRewardChip trajectory={trajectory} />
          </div>
          <pre className="max-h-[60vh] overflow-auto rounded-xl bg-ddc-surface-muted p-3 font-mono text-xs whitespace-pre text-ddc-text">
            {json}
          </pre>
        </>
      )}
    </Modal>
  );
}
