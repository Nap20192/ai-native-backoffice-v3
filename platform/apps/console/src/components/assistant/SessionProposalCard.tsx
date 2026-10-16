import type { ReactNode } from "react";

import type { PreviewResult, SessionPreviewInfo } from "../../lib/assistant/api";
import { OperationBody, ProposalShell, type ProposalItem } from "./ProposalCard";

/**
 * Карточка `create_session` (раздел 1.4 плана): агент и версия, окружение,
 * название, файлы. Ниже то, с чем сессия будет работать: инструменты агента,
 * его MCP-серверы и навыки, сеть окружения. Сессия создаётся пустой, агент
 * начнёт работу после первого сообщения.
 */

const EMPTY = "нет";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-ddc-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ddc-text">{children}</dd>
    </div>
  );
}

const joined = (list: string[]) => (list.length > 0 ? list.join(", ") : EMPTY);

function SessionDetails({ info }: { info: SessionPreviewInfo }) {
  const agent = info.agentName ?? info.agentId ?? "не указан";
  const version = info.agentVersion !== null ? `, версия ${info.agentVersion}` : "";
  return (
    <div className="flex flex-col gap-2 text-xs">
      <dl className="flex flex-col gap-1">
        <Row label="Агент">{`${agent}${version}`}</Row>
        <Row label="Окружение">{info.environmentName ?? info.environmentId ?? "не указано"}</Row>
        <Row label="Название">{info.title ?? "без названия"}</Row>
        <Row label="Файлы">
          {info.files.length > 0 ? (
            <ul className="flex flex-col gap-0.5" aria-label="Файлы сессии">
              {info.files.map((f, i) => (
                <li key={`${f.fileId}-${i}`}>
                  {f.filename ?? f.fileId}
                  {f.mountPath ? <span className="text-ddc-text-muted">{` → ${f.mountPath}`}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            EMPTY
          )}
        </Row>
      </dl>

      <div>
        <p className="mb-1 font-medium text-ddc-label">С чем сессия будет работать</p>
        <dl className="flex flex-col gap-1">
          <Row label="Инструменты">{joined(info.tools)}</Row>
          <Row label="MCP-серверы">{joined(info.mcpServers)}</Row>
          <Row label="Навыки">{joined(info.skills)}</Row>
          <Row label="Сеть">{info.network ?? "не указана"}</Row>
        </dl>
      </div>

      <p className="text-ddc-text-muted">Сессия создаётся пустой. Агент начнёт работу после первого сообщения</p>
    </div>
  );
}

export function SessionProposalCard({ item, sessionId }: { item: ProposalItem; sessionId: string }) {
  return (
    <ProposalShell item={item} sessionId={sessionId} title={() => "Создать сессию"}>
      {(preview: PreviewResult) => (
        <div className="flex flex-col gap-2">
          {preview.session ? <SessionDetails info={preview.session} /> : null}
          {preview.operations[0]?.warnings.length ? (
            <OperationBody op={{ ...preview.operations[0], afterYaml: null, beforeYaml: null }} />
          ) : null}
        </div>
      )}
    </ProposalShell>
  );
}
