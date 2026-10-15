import * as React from "react"

/**
 * Кнопка без собственных стилей. Нужна элементам, которые целиком оформлены
 * классами DDC из ddc-components.css (`tab`, `chip-toggle`, `segmented-item`,
 * `btn-add`, `menu-item`, `card-link`, `switch`, `kpi`): базовые классы
 * `Button` (рамка, радиус, высота, центрирование) перебили бы их вид.
 * Нативный `<button>` остаётся внутри components/ui (контракт
 * mature-components), `type="button"` по умолчанию, чтобы кнопка не
 * отправляла форму.
 */
function PlainButton({
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return <button data-slot="plain-button" type={type} {...props} />
}

export { PlainButton }
