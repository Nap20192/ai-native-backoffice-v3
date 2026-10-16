import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { useSearchParams } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DescribeAgent } from "../../components/assistant/describe/DescribeAgent";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { BUILDER_TEMPLATE } from "../../data/templates";
import { BuilderTemplateDialog } from "../quickstart/TemplateDialog";
import { AgentFormDialog } from "./AgentFormDialog";
import { PlainButton } from "@/components/ui/plain-button";

/**
 * `/agents/new` (раздел 1.3 плана builder-agent). Блок «Отправная точка» с
 * переключателем «Описать агента | Шаблон». Описание ведёт к чату с ассистентом
 * и панели конфигурации, шаблон к диалогу «Конструктора» или к форме агента с
 * обычными шаблонами.
 */

type Start = "describe" | "template";

const TABS: ReadonlyArray<{ id: Start; label: string }> = [
  { id: "describe", label: "Описать агента" },
  { id: "template", label: "Шаблон" },
];

export function AgentNewPage() {
  const [params, setParams] = useSearchParams();
  const start: Start = params.get("start") === "template" ? "template" : "describe";
  const [builderOpen, setBuilderOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const select = (next: Start) => {
    const copy = new URLSearchParams(params);
    if (next === "describe") copy.delete("start");
    else copy.set("start", next);
    setParams(copy, { replace: true });
  };

  return (
    <Page
      header={
        <PageHeader
          title="Новый агент"
          description="Опишите задачу обычными словами или начните с готового шаблона."
        />
      }
    >
      <section aria-label="Отправная точка" className="flex min-w-0 flex-col gap-4">
        <div role="tablist" aria-label="Отправная точка" className="flex w-fit gap-1 rounded-xl bg-ddc-surface-sunken p-1">
          {TABS.map((tab) => (
            <PlainButton
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={start === tab.id}
              onClick={() => select(tab.id)}
              className={cn(
                "h-8 rounded-lg px-3 text-sm font-medium",
                start === tab.id ? "bg-ddc-surface text-ddc-heading shadow-card" : "text-ddc-ghost-text hover:bg-ddc-ghost-hover",
              )}
            >
              {tab.label}
            </PlainButton>
          ))}
        </div>

        {start === "describe" ? (
          <DescribeAgent />
        ) : (
          <div className="grid max-w-[768px] gap-3 sm:grid-cols-2">
            <article
              aria-labelledby="template-builder"
              className="flex flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-4"
            >
              <Badge variant="info" className="w-fit">
                <SparklesIcon aria-hidden="true" />
                {BUILDER_TEMPLATE.badge}
              </Badge>
              <h2 id="template-builder" className="text-sm font-semibold text-ddc-heading">
                {BUILDER_TEMPLATE.name}
              </h2>
              <p className="text-sm text-ddc-text-muted">{BUILDER_TEMPLATE.description}</p>
              <div className="mt-auto pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setBuilderOpen(true)}>
                  Открыть шаблон «Конструктор»
                </Button>
              </div>
            </article>
            <article className="flex flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-4">
              <h2 className="text-sm font-semibold text-ddc-heading">Шаблоны для задач</h2>
              <p className="text-sm text-ddc-text-muted">
                Документовед, помощник по кадрам, аналитик договоров и другие заготовки. Форма откроется с готовым промптом.
              </p>
              <div className="mt-auto pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}>
                  Выбрать другой шаблон
                </Button>
              </div>
            </article>
          </div>
        )}
      </section>

      <BuilderTemplateDialog open={builderOpen} onClose={() => setBuilderOpen(false)} />
      <AgentFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={() => setFormOpen(false)}
        allAgents={[]}
        customSkills={[]}
      />
    </Page>
  );
}
