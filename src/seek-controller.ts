export type SeekExecutor = (positionMs: number) => Promise<void>;

const SUPERSEDED_SEEK_SETTLE_MS = 50;

type SeekRequest = {
  key: string;
  positionMs: number;
  execute: SeekExecutor;
};

export class SeekController {
  private requested: SeekRequest | null = null;
  private activeKey: string | null = null;
  private running: Promise<void> | null = null;
  private revision = 0;

  seek(positionMs: number, key: string, execute: SeekExecutor, cancel: () => void): Promise<void> {
    if (
      this.running &&
      (this.requested?.key === key || (!this.requested && this.activeKey === key))
    ) {
      return this.running;
    }
    this.revision += 1;
    this.requested = { key, positionMs: Math.max(0, Math.round(positionMs)), execute };
    if (this.activeKey !== null) cancel();
    if (!this.running) this.running = this.drain().finally(() => (this.running = null));
    return this.running;
  }

  reset(): void {
    this.revision += 1;
    this.requested = null;
  }

  private async drain(): Promise<void> {
    while (this.requested !== null) {
      const request = this.requested;
      this.requested = null;
      this.activeKey = request.key;
      try {
        await request.execute(request.positionMs);
      } catch (error) {
        if (!isAbortError(error) || this.requested === null) throw error;
      } finally {
        this.activeKey = null;
      }
      if (this.requested !== null) await this.waitForStableRequest();
    }
  }

  private async waitForStableRequest(): Promise<void> {
    while (this.requested !== null) {
      const revision = this.revision;
      await new Promise((resolve) => setTimeout(resolve, SUPERSEDED_SEEK_SETTLE_MS));
      if (revision === this.revision) return;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
