type RetryOptions = {
  timeoutMs?: number;
  budgetMs?: number;
  attempts?: number;
};

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** Only use for read-only provider calls, including their POST search APIs. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const deadline = Date.now() + (options.budgetMs ?? 25_000);
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    init.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException("Tempo de consulta excedido", "TimeoutError");
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 20_000, remaining)));
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response | undefined;
    let networkError: unknown;
    try {
      response = await fetch(url, { ...init, signal });
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      init.signal?.throwIfAborted();
      networkError = error;
    }
    const delay = Math.max(
      500 * 2 ** attempt,
      retryAfterMs(response?.headers.get("retry-after") ?? null),
    );
    if (attempt + 1 >= attempts || Date.now() + delay + 250 >= deadline) {
      if (response) return response;
      throw networkError;
    }
    await response?.body?.cancel().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const done = () => { init.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(done, delay);
      const abort = () => { clearTimeout(timer); reject(init.signal?.reason); };
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
    });
  }
}

type Health = { checkedAt: string; ok: boolean; code?: string };
const checks = new Map<string, Health>();
export function recordIntegrationCheck(provider: string, ok: boolean, code?: string) {
  checks.set(provider, { checkedAt: new Date().toISOString(), ok, ...(code ? { code } : {}) });
}
export function integrationHealth(provider: string) {
  const check = checks.get(provider);
  const fresh = check && Date.now() - Date.parse(check.checkedAt) < 15 * 60_000;
  return { connectionVerified: Boolean(fresh && check.ok), lastCheck: check ?? null };
}
