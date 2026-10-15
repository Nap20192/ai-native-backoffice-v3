import { ChartColumnIcon, TableIcon } from "lucide-react";

import { PlainButton } from "@/components/ui/plain-button";

export type ChartView = "chart" | "table";

/**
 * Переключатель «График | Таблица»: два значка в сегменте DDC. Выбранный
 * сегмент подсвечен, у каждой кнопки подпись для скринридера и подсказка.
 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ChartView;
  onChange: (next: ChartView) => void;
}) {
  const items: Array<{ id: ChartView; label: string; Icon: typeof TableIcon }> = [
    { id: "chart", label: "График", Icon: ChartColumnIcon },
    { id: "table", label: "Таблица", Icon: TableIcon },
  ];
  return (
    <div role="group" aria-label="Вид отображения" className="segmented h-9 flex-none">
      {items.map(({ id, label, Icon }) => (
        <PlainButton
          key={id}
          aria-label={label}
          title={label}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className="segmented-item px-2.5"
        >
          <Icon className="size-4" aria-hidden="true" />
        </PlainButton>
      ))}
    </div>
  );
}
