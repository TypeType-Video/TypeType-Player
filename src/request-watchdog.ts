export type RequestWatchdogTiming = {
  firstByteMs: number;
  idleMs: number;
};

export const MEDIA_REQUEST_WATCHDOG: RequestWatchdogTiming = {
  firstByteMs: 30_000,
  idleMs: 15_000,
};

export const API_REQUEST_WATCHDOG: RequestWatchdogTiming = {
  firstByteMs: 60_000,
  idleMs: 15_000,
};

export class RequestStallError extends Error {
  constructor() {
    super("Request stopped making progress");
    this.name = "RequestStallError";
  }
}

export class RequestWatchdog {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stalled = false;
  private readonly detachParent: () => void;
  private readonly abortion: Promise<never>;

  constructor(
    private readonly parent: AbortSignal | null | undefined,
    private readonly timing: RequestWatchdogTiming,
  ) {
    const abort = () => this.controller.abort(new DOMException("Operation aborted", "AbortError"));
    if (parent?.aborted) abort();
    parent?.addEventListener("abort", abort, { once: true });
    this.detachParent = () => parent?.removeEventListener("abort", abort);
    this.abortion = abortionOf(this.controller.signal);
    this.abortion.catch(() => undefined);
    this.arm(timing.firstByteMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  progress(): void {
    if (!this.controller.signal.aborted) this.arm(this.timing.idleMs);
  }

  async run<T>(work: Promise<T>): Promise<T> {
    try {
      return await Promise.race([work, this.abortion]);
    } catch (error) {
      throw this.translate(error);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detachParent();
  }

  private translate(error: unknown): unknown {
    if (this.parent?.aborted) return new DOMException("Operation aborted", "AbortError");
    return this.stalled ? new RequestStallError() : error;
  }

  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.controller.abort(new RequestStallError());
    }, delayMs);
  }
}

function abortionOf(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export async function readWatchedBody(
  response: Response,
  watchdog: RequestWatchdog,
): Promise<ArrayBuffer> {
  const body = response.body;
  if (!body) return watchdog.run(response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await watchdog.run(reader.read());
      if (chunk.done) break;
      watchdog.progress();
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  return concatChunks(chunks, length);
}

function concatChunks(chunks: Uint8Array[], length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
