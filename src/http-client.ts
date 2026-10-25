import {
  DEFAULT_REQUEST_WATCHDOG,
  RequestWatchdog,
  type RequestWatchdogTiming,
  readWatchedBody,
} from "./request-watchdog";
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
  watchdog?: RequestWatchdogTiming;
};

export type HttpExchange = {
  status: number;
  statusText: string;
  headers: Headers;
  body: ArrayBuffer;
};

export class HttpClient {
  private readonly timing: RetryTiming;
  private readonly watchdog: RequestWatchdogTiming;

  constructor(private readonly options: HttpClientOptions) {
    this.timing = options.retryTiming ?? SYSTEM_RETRY_TIMING;
    this.watchdog = options.watchdog ?? DEFAULT_REQUEST_WATCHDOG;
  }

  get retryTiming(): RetryTiming {
    return this.timing;
  }

  async json(path: string, init?: RequestInit): Promise<unknown> {
    const exchange = await this.fetch(path, init);
    return JSON.parse(new TextDecoder().decode(exchange.body));
  }

  async once(url: string, init?: RequestInit): Promise<HttpExchange> {
    const watchdog = new RequestWatchdog(init?.signal, this.watchdog);
    try {
      const response = await watchdog.run(this.fetchRaw(url, { ...init, signal: watchdog.signal }));
      watchdog.progress();
      const body = await readWatchedBody(response, watchdog);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body,
      };
    } finally {
      watchdog.dispose();
    }
  }

  absolute(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.normalizedEndpoint()).href;
  }

  retryAfterMs(headers: Headers): number | null {
    return parseRetryAfterMs(headers.get("retry-after"), this.timing.now());
  }

  private async fetch(path: string, init?: RequestInit): Promise<HttpExchange> {
    const exchange = await this.fetchWithTransientRetry(this.absolute(path), init);
    if (exchange.status < 200 || exchange.status > 299) {
      throw new TypeTypeHttpError(
        exchange.statusText,
        exchange.status,
        this.retryAfterMs(exchange.headers),
      );
    }
    return exchange;
  }

  private async fetchWithTransientRetry(url: string, init?: RequestInit): Promise<HttpExchange> {
    const budget = new RetryBudget(this.timing);
    while (true) {
      let exchange: HttpExchange;
      try {
        exchange = await this.once(url, init);
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (!(await budget.wait(null, init?.signal))) throw error;
        continue;
      }
      if (!TRANSIENT_STATUSES.has(exchange.status)) return exchange;
      if (!(await budget.wait(this.retryAfterMs(exchange.headers), init?.signal))) return exchange;
    }
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(this.options.headers);
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    return fetch(url, { ...init, headers, cache: init.cache ?? "no-store" });
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
