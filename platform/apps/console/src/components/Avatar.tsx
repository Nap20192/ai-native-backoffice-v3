import {
  Avatar as ShadcnAvatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Initial-circle avatar. Image when present, falls back to a brand-tinted
 * circle with the entity's first letter (uppercase). Used for tenants,
 * users, and bot personas — anywhere a visual id sits next to a name.
 *
 * Размеры по шкале аватаров DDC (правило 9): 24, 32, 40, 64, 96 пикселей.
 * Обёртка над shadcn `Avatar`: если картинка не загрузилась, показывается
 * буква. `squared` оставлен для аватаров рабочих пространств (читаются как
 * «пространство», а не «человек»).
 */
const SIZE: Record<"xs" | "sm" | "md" | "lg" | "xl", string> = {
  xs: "size-6 text-2xs",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-16 text-xl",
  xl: "size-24 text-3xl",
};

interface AvatarProps {
  /** Display name; first character is used for the fallback initial. */
  name: string;
  /** Optional image url (e.g. persona avatar from an integration). */
  src?: string | null;
  size?: keyof typeof SIZE;
  /** Use rounded-md (square-ish) instead of rounded-full. Tenant avatars
   *  use this so they read as "workspace" not "person". */
  squared?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = "md", squared, className = "" }: AvatarProps) {
  const initial = (name?.trim().charAt(0) || "?").toUpperCase();
  const shape = squared ? "rounded-md after:rounded-md *:rounded-md" : "rounded-full";

  return (
    <ShadcnAvatar className={cn(SIZE[size], shape, "shrink-0", className)}>
      {src && (
        <AvatarImage
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={squared ? "rounded-md" : undefined}
        />
      )}
      <AvatarFallback
        className={cn(
          "bg-brand-600 text-white font-semibold",
          squared ? "rounded-md" : "rounded-full",
        )}
      >
        {initial}
      </AvatarFallback>
    </ShadcnAvatar>
  );
}
