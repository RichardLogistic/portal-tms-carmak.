"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function safeRedirectTarget(value: string | null): string {
  if (!value) return "/portal.html";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("://")) {
    return "/portal.html";
  }
  return value;
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "E-mail ou senha inválidos.",
  AUTH_NOT_CONFIGURED: "Login ainda não configurado no servidor. Contate o responsável pela integração.",
};

function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTarget = safeRedirectTarget(searchParams.get("redirect"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active && data?.authenticated) {
          window.location.replace(redirectTarget);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, [redirectTarget]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        setError(
          (data?.code && ERROR_MESSAGES[data.code]) ||
            data?.message ||
            "Não foi possível entrar. Tente novamente.",
        );
        setSubmitting(false);
        return;
      }

      window.location.replace(redirectTarget);
    } catch {
      setError("Não foi possível contatar o servidor. Verifique sua conexão.");
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.page}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <h1 style={styles.title}>Portal TMS Carmak</h1>
        <p style={styles.subtitle}>Entre com sua conta corporativa para continuar.</p>

        <label style={styles.label} htmlFor="email">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          style={styles.input}
          disabled={checkingSession}
        />

        <label style={styles.label} htmlFor="password">
          Senha
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={styles.input}
          disabled={checkingSession}
        />

        <label style={styles.checkboxRow} htmlFor="remember">
          <input
            id="remember"
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={checkingSession}
          />
          Manter conectado por 30 dias
        </label>

        {error ? <p style={styles.error}>{error}</p> : null}

        <button type="submit" style={styles.button} disabled={submitting || checkingSession}>
          {submitting ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main style={styles.page} />}>
      <LoginForm />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#06110d",
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    background: "#0d2019",
    border: "1px solid #244d39",
    borderRadius: "14px",
    padding: "32px",
    boxShadow: "0 20px 50px rgba(0, 0, 0, 0.35)",
  },
  title: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 600,
    color: "#f4f8f5",
  },
  subtitle: {
    margin: "0 0 12px",
    fontSize: "14px",
    color: "#a8b9ae",
  },
  label: {
    fontSize: "13px",
    color: "#a8b9ae",
    marginTop: "6px",
  },
  input: {
    background: "#091813",
    border: "1px solid #173828",
    borderRadius: "8px",
    padding: "10px 12px",
    color: "#f4f8f5",
    fontSize: "14px",
    outline: "none",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "#a8b9ae",
    marginTop: "4px",
  },
  error: {
    margin: "4px 0 0",
    fontSize: "13px",
    color: "#ff5f62",
  },
  button: {
    marginTop: "12px",
    background: "#36c977",
    color: "#06110d",
    border: "none",
    borderRadius: "8px",
    padding: "11px",
    fontSize: "15px",
    fontWeight: 600,
    cursor: "pointer",
  },
};
