import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useAuth } from "../lib/auth";
import { toast } from "sonner";
import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ModernLoginShell } from "@/components/ui/modern-login-signup";
import { Field } from "../components/Field";
import { GitHubIcon } from "../components/icons";
import { Turnstile } from "../components/Turnstile";
import { Logo } from "../components/Logo";
import { setActiveTenantId } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { useI18n } from "../i18n";
import { useBranding } from "../lib/branding";

// Clear browser-cached tenant pin on every successful auth transition.
// The pin is per-user — different login → different membership set →
// the previous user's tenant id is at best meaningless and at worst
// triggers "Not a member" 403s on every subsequent request.
// TenantSwitcher repopulates from /v1/oma/me/tenants on next page load.
function onLoginSuccess(redirect: () => void) {
  setActiveTenantId(null);
  redirect();
}

type Mode =
  | "chooser"
  | "login"
  | "signup"
  | "otp-login"
  | "verify-signup"
  | "verify-login"
  | "forgot"
  | "reset-otp";

/** Знак Google: четыре цвета заданы брендом Google и токенами не заменяются. */
function GoogleIcon() {
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function Login() {
  const { isAuthenticated, isLoading } = useAuth();
  const branding = useBranding();
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("chooser");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();
  // /auth-info is a public unauthenticated endpoint advertising which
  // providers (google / github / email-otp) are wired up and the Turnstile public
  // site key. TQ keeps the result cached + deduped across this page's
  // re-mounts so a navigation between modes doesn't refetch.
  const { data: authInfo } = useApiQuery<{
    providers?: string[];
    oidc?: { id: string; name: string }[];
    email_password?: boolean;
    turnstile_site_key?: string | null;
  }>("/auth-info");
  const googleEnabled = !!authInfo?.providers?.includes("google");
  const githubEnabled = !!authInfo?.providers?.includes("github");
  // Deployment-configured OpenID Connect providers, for example a company SSO.
  const oidcProviders = authInfo?.oidc ?? [];
  // A deployment may turn email and password off and leave only SSO. Older
  // backends omit the field; treat that as on.
  const emailEnabled = authInfo?.email_password !== false;
  // Whether the backend gates sign-up behind an email-OTP verification.
  // /auth-info advertises "email-otp" iff AUTH_REQUIRE_EMAIL_VERIFY=1 on
  // the server. When absent (default self-host), the sign-up flow does
  // NOT route through verify-signup — sign-up succeeds → session cookie
  // → straight to /. Avoids stranding the user on a verify screen with
  // no way to receive the code.
  const emailVerifyRequired = !!authInfo?.providers?.includes("email-otp");
  // Turnstile site key (public) is read from /auth-info; null when the
  // backend hasn't been configured yet, in which case the auth middleware
  // also soft-passes — both sides agree to skip the check.
  const turnstileSiteKey = authInfo?.turnstile_site_key ?? null;
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumping this counter re-mounts the Turnstile widget after each form
  // submission so the next attempt gets a fresh single-use token.
  const [turnstileNonce, setTurnstileNonce] = useState(0);
  const otpRef = useRef<HTMLInputElement>(null);

  // Honor `?next=` so callers (e.g. /cli/login) can bounce through here and
  // land back where they started after sign-in. Restricted to same-origin
  // paths so a malicious link can't trick the user into redirecting offsite.
  const nextUrl = (() => {
    const raw = new URLSearchParams(window.location.search).get("next");
    if (!raw) return "/";
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    return "/";
  })();

  // Auto-redirect when an already-authenticated user lands on /login (e.g.
  // a stale tab, a successful auth handler whose explicit nav silently
  // dropped, or someone hitting /login?next=... with an existing session).
  // Each mode handler below ALSO calls nav(nextUrl) on success; this
  // effect catches anything that fell through.
  //
  // Subtlety: we DON'T call onLoginSuccess() here because that resets
  // active tenant — fine when the user just signed in (membership may
  // have changed) but unwanted when they're just being bounced through
  // /login with an existing session. Tenant reset is the handlers' job;
  // this effect is just a safety net to make sure an authenticated user
  // never gets stranded on the login form.
  //
  // We also wait for !isLoading so we don't fire while Better Auth's
  // useSession is still pending its first result (isAuthenticated reads
  // spuriously false during that window).
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      nav(nextUrl, { replace: true });
    }
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (
      (mode === "verify-signup" || mode === "verify-login" || mode === "reset-otp") &&
      otpRef.current
    ) {
      otpRef.current.focus();
    }
  }, [mode]);

  const clearOtp = () => setOtp("");

  // Modes that trigger an outbound email — those need a Turnstile token.
  // Verify modes (verify-signup, verify-login) submit OTP and don't send
  // mail, so they don't need the widget.
  const isEmailSendMode =
    mode === "signup" ||
    mode === "login" ||
    mode === "otp-login" ||
    mode === "forgot";

  // Submit can fire before Turnstile has minted a token (user clicks fast,
  // cold script load, etc.). Rather than disabling the button — which
  // makes the form feel "not ready" — we let the click through and await
  // the token via a queue. The widget's onToken callback drains all
  // pending resolvers, then submit proceeds with the real request.
  const tokenRef = useRef("");
  const pendingTokenResolvers = useRef<Array<(token: string) => void>>([]);
  const handleTurnstileToken = (token: string) => {
    tokenRef.current = token;
    setTurnstileToken(token);
    const queued = pendingTokenResolvers.current;
    pendingTokenResolvers.current = [];
    for (const resolve of queued) resolve(token);
  };
  const waitForTurnstileToken = (): Promise<string> => {
    if (!turnstileSiteKey) return Promise.resolve(""); // soft-pass when unconfigured
    if (tokenRef.current) return Promise.resolve(tokenRef.current);
    // 30s ceiling so a stuck widget doesn't hang the form forever.
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTokenResolvers.current = pendingTokenResolvers.current.filter((r) => r !== wrapped);
        reject(new Error(t.login.botChallengeTimeout));
      }, 30_000);
      const wrapped = (token: string) => {
        clearTimeout(timer);
        resolve(token);
      };
      pendingTokenResolvers.current.push(wrapped);
    });
  };
  const resetTurnstile = () => {
    tokenRef.current = "";
    setTurnstileToken("");
    setTurnstileNonce((n) => n + 1);
  };

  /** Build fetchOptions with the Turnstile token (await if it hasn't
   *  arrived yet). Returns undefined when Turnstile isn't configured at
   *  all — middleware soft-passes in that case. */
  const buildTurnstileOpts = async () => {
    if (!turnstileSiteKey) return undefined;
    const token = await waitForTurnstileToken();
    return { headers: { "cf-turnstile-token": token } };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Block on Turnstile up front for email-send modes so any subsequent
      // authClient call already has the header. The user just sees the
      // submit button spin — they don't see a separate "verifying" state.
      const turnstileFetchOpts = isEmailSendMode ? await buildTurnstileOpts() : undefined;

      if (mode === "signup") {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
          fetchOptions: turnstileFetchOpts,
        });
        if (error) throw new Error(error.message);
        clearOtp();
        if (emailVerifyRequired) {
          // OTP gate enabled — show verify screen, OTP delivered via
          // operator's sendVerificationOTP wiring.
          setMode("verify-signup");
        } else {
          // Default self-host (no SMTP) — better-auth already created a
          // session cookie at sign-up. Either we already see it via
          // useAuth (the redirect effect at the top fires), or the
          // session writes briefly raced; explicit signIn.email is the
          // belt-and-braces path that always lands the cookie.
          await authClient.signIn.email({ email, password });
          onLoginSuccess(() => nav(nextUrl, { replace: true }));
        }
      } else if (mode === "login") {
        const { error } = await authClient.signIn.email({
          email,
          password,
          fetchOptions: turnstileFetchOpts,
        });
        if (error) {
          // better-auth signals "needs to verify email" via code=EMAIL_NOT_VERIFIED
          // (message is "Email not verified" — note `verifIED`, which is why
          // includes("verify")/("verification") both miss it). Match the code
          // first, fall back to broader substring for non-better-auth backends.
          const needsVerify =
            (error as { code?: string }).code === "EMAIL_NOT_VERIFIED" ||
            error.message?.toLowerCase().includes("verif");
          if (needsVerify) {
            // Need a fresh token — the previous one was consumed by signIn.email.
            const reSendOpts = await buildTurnstileOpts();
            await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
              fetchOptions: reSendOpts,
            });
            clearOtp();
            setMode("verify-signup");
          } else {
            throw new Error(error.message);
          }
        } else {
          onLoginSuccess(() => nav(nextUrl, { replace: true }));
        }
      } else if (mode === "otp-login") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "sign-in",
          fetchOptions: turnstileFetchOpts,
        });
        if (error) throw new Error(error.message);
        clearOtp();
        setMode("verify-login");
      } else if (mode === "verify-signup") {
        const { error } = await authClient.emailOtp.verifyEmail({
          email,
          otp,
        });
        if (error) throw new Error(error.message);
        onLoginSuccess(() => nav(nextUrl, { replace: true }));
      } else if (mode === "verify-login") {
        const signInOtp = authClient.signIn.emailOtp as any;
        const { error } = await signInOtp({ email, otp });
        if (error) throw new Error(error.message);
        // No `if (data)` guard — better-auth's client wrapper sometimes
        // returns a falsy `data` even on a successful sign-in (server
        // sets the session cookie either way). Treating absence-of-error
        // as success matches every other handler in this file and keeps
        // the user from getting stranded on the verify form.
        onLoginSuccess(() => nav(nextUrl, { replace: true }));
      } else if (mode === "forgot") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "forget-password",
          fetchOptions: turnstileFetchOpts,
        });
        if (error) throw new Error(error.message);
        clearOtp();
        setPassword("");
        setMode("reset-otp");
      } else if (mode === "reset-otp") {
        const res = await fetch("/auth/email-otp/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, otp, password }),
        });
        const data = await res.json() as any;
        if (!res.ok) throw new Error(data?.message || "Не удалось сбросить пароль");
        setError("");
        setMode("login");
        toast.success(t.login.passwordResetSuccess);
      }
    } catch (err: any) {
      // Surface real cause when present. Anthropic-style envelope nests as
      // `{error:{type,message}}`; better-auth surfaces top-level `message`.
      // Some upstream limiters (CF Rate Limiting binding) only set the
      // nested form — read both before falling back to a generic string.
      const msg =
        err?.message ||
        err?.error?.message ||
        err?.body?.error?.message ||
        t.login.authFailed;
      setError(msg);
    } finally {
      // Always reset the Turnstile token after a submit attempt — tokens
      // are single-use, so we'd 401 on the next try otherwise.
      if (isEmailSendMode) resetTurnstile();
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setLoading(true);
    try {
      const typeMap: Record<string, "sign-in" | "email-verification" | "forget-password"> = {
        "verify-signup": "email-verification",
        "verify-login": "sign-in",
        "reset-otp": "forget-password",
      };
      const opts = await buildTurnstileOpts();
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: typeMap[mode] || "email-verification",
        fetchOptions: opts,
      });
      if (error) throw new Error(error.message);
      clearOtp();
    } catch (err: any) {
      setError(err.message || "Не удалось отправить код ещё раз");
    } finally {
      resetTurnstile();
      setLoading(false);
    }
  };

  const handleSocialSignIn = async (provider: "google" | "github") => {
    await authClient.signIn.social({
      provider,
      callbackURL: nextUrl,
    });
  };

  const handleOidcSignIn = async (providerId: string) => {
    setError("");
    const { error } = await authClient.signIn.oauth2({
      providerId,
      callbackURL: nextUrl,
    });
    if (error) setError(error.message ?? t.login.authFailed);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ddc-surface text-sm text-muted">
        <Spinner />
      </div>
    );
  }

  const isOtpMode = mode === "verify-signup" || mode === "verify-login" || mode === "reset-otp";

  const titles: Record<Mode, string> = {
    chooser: branding.loginTitle ?? `Вход в ${branding.productName}`,
    login: "Вход по почте",
    signup: "Создание учётной записи",
    "otp-login": "Вход по коду из письма",
    "verify-signup": "Подтверждение почты",
    "verify-login": "Введите код",
    forgot: "Сброс пароля",
    "reset-otp": "Новый пароль",
  };

  const subtitles: Record<Mode, string> = {
    chooser: branding.loginSubtitle ?? "",
    login: "Введите почту и пароль",
    signup: `Начните работу с ${branding.productName}`,
    "otp-login": "Отправим 6-значный код на вашу почту",
    "verify-signup": `Мы отправили код на ${email}`,
    "verify-login": `Мы отправили код на ${email}`,
    forgot: "Отправим код для сброса пароля",
    "reset-otp": `Введите код из письма, отправленного на ${email}`,
  };

  // Ссылка в строке текста: подпись без отступов, зона нажатия расширена
  // невидимым слоем до 44px по высоте (правило 13: цель не меньше 32px).
  const compactLinkClass =
    "relative h-auto px-0 py-0 after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']";
  // Подпись поля DDC (`.label`): 12px, medium, ink-600.
  const labelClass = "text-xs leading-4 font-medium text-ddc-label";
  const errorBox = (id?: string) =>
    error && (
      <div id={id} role="alert" aria-live="polite" className="callout-danger">
        <AlertCircleIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
        <span className="min-w-0 break-words">{error}</span>
      </div>
    );

  return (
    <ModernLoginShell>
      <div className="flex flex-col gap-8">
        <header>
          <div className="mb-8 flex lg:hidden">
            <Logo size="lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-ddc-heading">
            {titles[mode]}
          </h1>
          {subtitles[mode] && (
            <p className="mt-1 text-sm text-muted">{subtitles[mode]}</p>
          )}
        </header>

        {mode === "chooser" && (
          <div role="group" aria-label="Способы входа" className="flex flex-col gap-3">
            {errorBox()}
            {oidcProviders.map((p, i) => (
              <Button
                key={p.id}
                type="button"
                variant={i === 0 ? "default" : "outline"}
                onClick={() => handleOidcSignIn(p.id)}
                className="w-full"
              >
                Продолжить через {p.name}
              </Button>
            ))}
            {googleEnabled && (
              <Button
                type="button"
                variant={oidcProviders.length > 0 ? "outline" : "default"}
                onClick={() => handleSocialSignIn("google")}
                className="w-full"
              >
                <GoogleIcon />
                Продолжить через Google
              </Button>
            )}
            {githubEnabled && (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleSocialSignIn("github")}
                className="w-full"
              >
                <GitHubIcon className="size-4" />
                Продолжить через GitHub
              </Button>
            )}
            {emailEnabled && (
              <Button
                type="button"
                variant={
                  googleEnabled || githubEnabled || oidcProviders.length > 0
                    ? "outline"
                    : "default"
                }
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="w-full"
              >
                Продолжить с почтой
              </Button>
            )}
          </div>
        )}

        {mode !== "chooser" && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {errorBox("auth-error")}

          {mode === "signup" && (
            <Field label="Имя">
              <Input
                id="auth-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ваше имя"
                autoComplete="name"
              />
            </Field>
          )}

          {!isOtpMode && (
            <Field label="Почта">
              <Input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                required
                autoFocus
                name="email"
                autoComplete={mode === "signup" ? "email" : "username"}
              />
            </Field>
          )}

          {(mode === "login" || mode === "signup") && (
            <div data-login-field="password">
              <div className="mb-1.5 flex items-center justify-between">
                <Label htmlFor="auth-password" className={labelClass}>
                  Пароль
                </Label>
                {mode === "login" && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => {
                      setMode("forgot");
                      setError("");
                    }}
                    className={compactLinkClass}
                  >
                    Забыли пароль?
                  </Button>
                )}
              </div>
              <Input
                id="auth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.login.minChars}
                required
                minLength={8}
                name="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </div>
          )}

          {isOtpMode && (
            <Field label="Код подтверждения">
              <Input
                id="auth-otp"
                ref={otpRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                className="text-center font-mono text-lg tracking-[0.5em] tabular-nums"
                placeholder="000000"
                required
                autoComplete="one-time-code"
              />
            </Field>
          )}

          {mode === "reset-otp" && (
            <Field label="Новый пароль">
              <Input
                id="auth-new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.login.minChars}
                required
                minLength={8}
                name="new-password"
                autoComplete="new-password"
              />
            </Field>
          )}

          {isEmailSendMode && turnstileSiteKey && (
            <div className="hidden" aria-hidden="true">
              <Turnstile
                key={turnstileNonce}
                siteKey={turnstileSiteKey}
                onToken={handleTurnstileToken}
                onExpire={resetTurnstile}
              />
            </div>
          )}

          <div
            role="group"
            aria-label={mode === "login" ? "Действия входа" : "Действия формы"}
            className="flex flex-col gap-2 pt-1"
          >
            <Button
              type="submit"
              size="lg"
              loading={loading}
              disabled={
                (!isOtpMode && !email) ||
                (isOtpMode && otp.length < 6) ||
                ((mode === "login" || mode === "signup") && !password) ||
                (mode === "reset-otp" && !password)
              }
              className="w-full"
            >
              {mode === "login"
                ? "Войти"
                : mode === "signup"
                  ? "Создать учётную запись"
                  : mode === "otp-login"
                    ? "Отправить код"
                    : mode === "forgot"
                      ? "Отправить код сброса"
                      : mode === "reset-otp"
                        ? "Сбросить пароль"
                        : "Подтвердить"}
            </Button>
            {mode === "login" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setMode("otp-login");
                  setError("");
                }}
                className="w-full"
              >
                Войти по коду из письма
              </Button>
            )}
          </div>
        </form>
        )}

        {mode !== "chooser" && isOtpMode && (
          <div className="text-center text-sm text-muted">
            Не получили код?{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={handleResend}
              disabled={loading}
              className={compactLinkClass}
            >
              Отправить ещё раз
            </Button>
          </div>
        )}

        {mode === "login" && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => {
              setMode("chooser");
              setError("");
            }}
            className={`${compactLinkClass} self-center text-ddc-label`}
          >
            К способам входа
          </Button>
        )}

        <div
          role="group"
          aria-label="Параметры учётной записи"
          className="flex min-h-6 flex-wrap items-center justify-center gap-1 text-center text-sm text-muted"
        >
          {mode === "chooser" && emailEnabled && (
            <>
              <span>Нет учётной записи?</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className={compactLinkClass}
              >
                Зарегистрироваться
              </Button>
            </>
          )}
          {mode === "login" && (
            <>
              <span>Впервые в {branding.productName}?</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className={compactLinkClass}
              >
                Зарегистрироваться
              </Button>
            </>
          )}
          {mode === "signup" && (
            <>
              <span>Уже есть учётная запись?</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className={compactLinkClass}
              >
                Войти
              </Button>
            </>
          )}
          {mode === "otp-login" && (
            <>
              <span>Удобнее с паролем?</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className={compactLinkClass}
              >
                Войти
              </Button>
            </>
          )}
          {(mode === "verify-signup" || mode === "verify-login") && (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                setMode(mode === "verify-signup" ? "signup" : "otp-login");
                setError("");
                clearOtp();
              }}
              className={compactLinkClass}
            >
              Назад
            </Button>
          )}
          {mode === "forgot" && (
            <>
              <span>Вспомнили пароль?</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className={compactLinkClass}
              >
                Войти
              </Button>
            </>
          )}
          {mode === "reset-otp" && (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                setMode("forgot");
                setError("");
                clearOtp();
              }}
              className={compactLinkClass}
            >
              Назад
            </Button>
          )}
        </div>
      </div>
    </ModernLoginShell>
  );
}
