type QueueItem = {
  kind: "append" | "remove" | "parser";
  action: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class AppendQueue {
  private readonly queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private disposed = false;

  constructor(private readonly sourceBuffer: SourceBuffer) {
    sourceBuffer.addEventListener("updateend", this.handleUpdateEnd);
    sourceBuffer.addEventListener("error", this.handleError);
  }

  append(data: ArrayBuffer): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Append queue is disposed"));
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind: "append",
        action: () => this.sourceBuffer.appendBuffer(data),
        resolve,
        reject,
      });
      this.drain();
    });
  }

  remove(startSeconds: number, endSeconds: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Append queue is disposed"));
    if (endSeconds <= startSeconds) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({
        kind: "remove",
        action: () => this.sourceBuffer.remove(startSeconds, endSeconds),
        resolve,
        reject,
      });
      this.drain();
    });
  }

  /**
   * Forgets a media segment appended only in part, once the appends before it are done, so the next append starts
   * a segment from its beginning (SourceBuffer.abort resets the parser and fires no event when idle).
   */
  resetParser(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Append queue is disposed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "parser", action: () => this.sourceBuffer.abort(), resolve, reject });
      this.drain();
    });
  }

  buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  reset(): Promise<void> {
    const buffered = this.sourceBuffer.buffered;
    const range =
      buffered.length > 0
        ? { start: buffered.start(0), end: buffered.end(buffered.length - 1) }
        : null;
    this.clear();
    return range ? this.remove(range.start, range.end) : Promise.resolve();
  }

  clear(): void {
    const error = new DOMException("Operation aborted", "AbortError");
    const current = this.current;
    current?.reject(error);
    for (const item of this.queue.splice(0)) item.reject(error);
    this.current = null;
    if (this.sourceBuffer.updating && current?.kind === "append") this.sourceBuffer.abort();
  }

  destroy(): void {
    this.disposed = true;
    const error = new DOMException("Operation aborted", "AbortError");
    const current = this.current;
    current?.reject(error);
    for (const item of this.queue.splice(0)) item.reject(error);
    this.current = null;
    if (this.sourceBuffer.updating && current?.kind === "append") this.sourceBuffer.abort();
    this.sourceBuffer.removeEventListener("updateend", this.handleUpdateEnd);
    this.sourceBuffer.removeEventListener("error", this.handleError);
  }

  private readonly handleUpdateEnd = (): void => {
    this.current?.resolve();
    this.current = null;
    this.drain();
  };

  private readonly handleError = (): void => {
    this.current?.reject(new Error("SourceBuffer append failed"));
    this.current = null;
    this.drain();
  };

  private drain(): void {
    if (this.disposed || this.current || this.sourceBuffer.updating) return;
    const item = this.queue.shift();
    if (!item) return;
    this.current = item;
    try {
      item.action();
      if (item.kind === "parser") {
        this.current = null;
        item.resolve();
        this.drain();
      }
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error("SourceBuffer append failed"));
      this.current = null;
      this.drain();
    }
  }
}
