/**
 * Шаблоны окна «Новое окружение». Шаблон заполняет пакеты окружения, сервер
 * ставит их при каждом старте песочницы (apt, затем pip). Метка
 * `metadata.oma_template` показывает, из какого шаблона создано окружение
 * (план docs/plans/environments.md, раздел 2.1).
 */
export interface EnvironmentTemplate {
  id: "empty" | "documents";
  label: string;
  hint: string;
  packages?: { apt: string[]; pip: string[] };
}

export const ENVIRONMENT_TEMPLATES: EnvironmentTemplate[] = [
  {
    id: "empty",
    label: "Пустое",
    hint: "Только то, что есть в образе песочницы. Пакеты можно добавить потом в карточке окружения.",
  },
  {
    id: "documents",
    label: "Документы",
    hint:
      "Для встроенных навыков Word, PDF, PowerPoint и Excel. apt: python3-pip, fonts-dejavu-core " +
      "(шрифт с кириллицей). pip: python-docx, openpyxl, python-pptx, pypdf, reportlab, pdfplumber. " +
      "Пакеты ставятся при каждом старте песочницы и удлиняют его.",
    packages: {
      apt: ["python3-pip", "fonts-dejavu-core"],
      pip: ["python-docx", "openpyxl", "python-pptx", "pypdf", "reportlab", "pdfplumber"],
    },
  },
];

/** Поля `config` и `metadata` для создания окружения по шаблону. */
export function environmentTemplateFields(templateId: EnvironmentTemplate["id"]): {
  config: {
    type: "cloud";
    packages?: { type: "packages"; apt: string[]; pip: string[] };
  };
  metadata?: Record<string, string>;
} {
  const template = ENVIRONMENT_TEMPLATES.find((t) => t.id === templateId);
  if (!template?.packages) return { config: { type: "cloud" } };
  return {
    config: {
      type: "cloud",
      packages: {
        type: "packages",
        apt: [...template.packages.apt],
        pip: [...template.packages.pip],
      },
    },
    metadata: { oma_template: template.id },
  };
}
