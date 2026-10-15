/**
 * Логотип развёртывания. Консоль не несёт собственного знака: без логотипа,
 * который оператор задал в CONSOLE_BRANDING_DIR, компонент ничего не рисует,
 * а название продукта остаётся текстом рядом (панель входа, подписи страниц).
 * Родитель прячет пустую обёртку через `empty:hidden`, чтобы раскладка
 * не получала лишних отступов.
 *
 * Логотип развёртывания держит высоту знака, а ширина следует картинке.
 */
import { useBranding } from "../lib/branding";

const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 32,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  className?: string;
}

export function Logo({ size = "sm", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  const branding = useBranding();
  if (!branding.logoUrl) return null;

  const img = (src: string, variant: string) => (
    <img
      src={src}
      alt={branding.productName}
      style={{ height: px, width: "auto", maxWidth: px * 6 }}
      className={`shrink-0 object-contain ${variant} ${className}`.trim()}
    />
  );
  return branding.logoDarkUrl ? (
    <>
      {img(branding.logoUrl, "dark:hidden")}
      {img(branding.logoDarkUrl, "hidden dark:block")}
    </>
  ) : (
    img(branding.logoUrl, "")
  );
}
