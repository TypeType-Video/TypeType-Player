export class TypeTypeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TypeTypeHttpError";
  }
}

const MAX_TRANSIENT_RETRIES = 24;
const MAX_RETRY_DELAY_MS = 3_000;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export type HttpClientOptions = {
  endpoint: string;
  headers?: HeadersInit;
};

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetch(path, init);
    return response.json();
  }

  async text(url: string, init?: RequestInit): Promise<string> {
    const response = await this.fetchAbsolute(url, init);
    return response.text();
  }

  async bytes(url: string, init?: RequestInit): Promise<ArrayBuffer> {
    const response = await this.fetchAbsolute(url, init);
    return response.arrayBuffer();
  }

  response(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchWithTransientRetry(url, init);
  }

  absolute(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.normalizedEndpoint()).href;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchAbsolute(this.absolute(path), init);
  }

  private async fetchAbsolute(url: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchWithTransientRetry(url, init);
    if (!response.ok) throw new TypeTypeHttpError(response.statusText, response.status);
    return response;
  }

  private async fetchWithTransientRetry(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetchRaw(url, init);
        if (!TRANSIENT_STATUSES.has(response.status) || attempt >= MAX_TRANSIENT_RETRIES)
          return response;
        await retryDelay(response, attempt, init?.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (attempt >= MAX_TRANSIENT_RETRIES) throw error;
        await retryDelay(null, attempt, init?.signal);
      }
    }
  }

  private async fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(this.options.headers);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    return fetch(url, { ...init, headers, cache: init?.cache ?? "no-store" });
  }

  private normalizedEndpoint(): string {
    return this.options.endpoint.endsWith("/")
      ? this.options.endpoint
      : `${this.options.endpoint}/`;
  }
}

function retryDelay(
  response: Response | null,
  attempt: number,
  signal?: AbortSignal | null,
): Promise<void> {
  const headerDelay = response ? retryAfterMs(response.headers.get("retry-after")) : null;
  const delayMs = headerDelay ?? Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
    }
  });
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, dateMs - Date.now()));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
