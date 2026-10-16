import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { BUILDER_TEMPLATE } from "../../data/templates";
import { DescribeAgentBox } from "./DescribeAgentBox";
import { BuilderTemplateDialog } from "./TemplateDialog";

/**
 * `/quickstart` (раздел 1.3 и 1.5 плана builder-agent): поле «Что хотите
 * построить?» и карточка шаблона «Конструктор». Текст уходит в мастер через
 * состояние маршрута, не через адрес: он может содержать что угодно.
 */
export function QuickstartPage() {
  const navigate = useNavigate();
  const [builderOpen, setBuilderOpen] = useState(false);

  return (
    <Page
      header={
        <PageHeader
          title="Быстрый старт"
          description="Опишите задачу, и ассистент поможет собрать агента, окружение и первую сессию."
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-8">
        <DescribeAgentBox onSubmit={(prompt) => navigate("/quickstart/new", { state: { prompt } })} />

        <section aria-label="Шаблоны" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ddc-heading">Или начните с шаблона</h2>
          <div className="grid max-w-[768px] gap-3 sm:grid-cols-2">
            <article
              aria-labelledby="quickstart-template-builder"
              className="flex flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-4"
            >
              <Badge variant="info" className="w-fit">
                <SparklesIcon aria-hidden="true" />
                {BUILDER_TEMPLATE.badge}
              </Badge>
              <h3 id="quickstart-template-builder" className="text-sm font-semibold text-ddc-heading">
                {BUILDER_TEMPLATE.name}
              </h3>
              <p className="text-sm text-ddc-text-muted">{BUILDER_TEMPLATE.description}</p>
              <div className="mt-auto pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setBuilderOpen(true)}>
                  Открыть шаблон «Конструктор»
                </Button>
              </div>
            </article>
          </div>
          <Link to="/agents/new?start=template" className="w-fit text-sm text-ddc-link hover:underline">
            Другие шаблоны
          </Link>
        </section>
      </div>

      <BuilderTemplateDialog open={builderOpen} onClose={() => setBuilderOpen(false)} />
    </Page>
  );
}
