import { parseRetryAfterMs, RetryBudget } from "./retry-backoff";
import { type RetryTiming, SYSTEM_RETRY_TIMING } from "./retry-timing";

export class TypeTypeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TypeTypeHttpError";
  }
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export type HttpClientOptions = {
  endpoint: string;
  headers?: HeadersInit;
  retryTiming?: RetryTiming;
};

export class HttpClient {
  private readonly timing: RetryTiming;

  constructor(private readonly options: HttpClientOptions) {
    this.timing = options.retryTiming ?? SYSTEM_RETRY_TIMING;
  }

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
    if (!response.ok) {
      throw new TypeTypeHttpError(
        response.statusText,
        response.status,
        this.retryAfterMs(response),
      );
    }
    return response;
  }

  private async fetchWithTransientRetry(url: string, init?: RequestInit): Promise<Response> {
    const budget = new RetryBudget(this.timing);
    while (true) {
      let response: Response;
      try {
        response = await this.fetchRaw(url, init);
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (!(await budget.wait(null, init?.signal))) throw error;
        continue;
      }
      if (!TRANSIENT_STATUSES.has(response.status)) return response;
      if (!(await budget.wait(this.retryAfterMs(response), init?.signal))) return response;
      void response.body?.cancel().catch(() => undefined);
    }
  }

  private retryAfterMs(response: Response): number | null {
    return parseRetryAfterMs(response.headers.get("retry-after"), this.timing.now());
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
