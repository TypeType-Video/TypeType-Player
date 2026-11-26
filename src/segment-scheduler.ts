import type { EventEmitter } from "./event-emitter";
import type { HttpClient } from "./http-client";
import type { ManifestSegment, PlaybackManifest } from "./manifest";
import type {
  AppendResult,
  MediaBufferedRange,
  MediaSourceController,
} from "./media-source-controller";
import { fetchSegmentBytes, PartialSegmentError } from "./segment-fetcher";
import type { TrackKind } from "./types";

const BUFFERED_RANGE_TOLERANCE_MS = 50;
const APPENDED_RANGE_TOLERANCE_MS = 450;

export type SegmentFillResult = "filled" | "deferred";

export class SegmentScheduler {
  private readonly appended = new Set<string>();
  private readonly primed = new Map<string, Promise<ArrayBuffer>>();
  private readonly recheckAttempts = new Map<string, number>();
  private readonly appending = new Map<string, Promise<boolean>>();
  private revision = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly media: Pick<
      MediaSourceController,
      "append" | "bufferedRanges" | "resetParser"
    >,
    private readonly emitter: EventEmitter,
    private readonly pollLimit: number,
  ) {}

  reset(): void {
    this.revision += 1;
    this.appended.clear();
    this.recheckAttempts.clear();
    this.appending.clear();
  }

  /** Starts downloading the first media of a session that is not attached yet. */
  prime(manifest: PlaybackManifest, fromMs: number, goalMs: number, signal?: AbortSignal): void {
    this.primed.clear();
    const urls = [
      manifest.audio.initUrl,
      ...primedSegmentUrls(manifest.audio.segments, fromMs, goalMs),
    ];
    if (manifest.video) {
      urls.push(
        manifest.video.initUrl,
        ...primedSegmentUrls(manifest.video.segments, fromMs, goalMs),
      );
    }
    for (const url of urls) {
      const bytes = fetchSegmentBytes(
        this.http,
        url,
        this.pollLimit,
        signal,
        this.http.retryTiming,
      );
      bytes.catch(() => undefined);
      this.primed.set(url, bytes);
    }
  }

  discardPrimed(): void {
    this.primed.clear();
  }

  async appendInit(manifest: PlaybackManifest, signal?: AbortSignal): Promise<void> {
    const revision = this.revision;
    const tasks = [this.appendUrl("audio", manifest.audio.initUrl, 0, 0, revision, signal)];
    if (manifest.video) {
      tasks.push(this.appendUrl("video", manifest.video.initUrl, 0, 0, revision, signal));
    }
    const appended = await Promise.all(tasks);
    if (appended.includes(false)) throw new Error("SourceBuffer quota exceeded");
  }

  async fill(
    manifest: PlaybackManifest,
    currentMs: number,
    goalMs: number,
    signal?: AbortSignal,
  ): Promise<SegmentFillResult> {
    const revision = this.revision;
    const tasks = [
      this.fillTrack("audio", manifest.audio.segments, currentMs, goalMs, revision, signal),
    ];
    if (manifest.video) {
      tasks.push(
        this.fillTrack("video", manifest.video.segments, currentMs, goalMs, revision, signal),
      );
    }
    const results = await Promise.all(tasks);
    return results.includes("deferred") ? "deferred" : "filled";
  }

  private async fillTrack(
    kind: TrackKind,
    segments: ManifestSegment[],
    currentMs: number,
    goalMs: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<SegmentFillResult> {
    const candidates = segments
      .filter(
        (segment) => segment.startMs + segment.durationMs > currentMs && segment.startMs <= goalMs,
      )
      .sort((left, right) => left.startMs - right.startMs);
    for (const segment of candidates) {
      const segmentEndMs = segment.startMs + segment.durationMs;
      if (this.isBuffered(kind, segment.startMs, segmentEndMs)) {
        this.recheckAttempts.delete(`${kind}:${segment.url}`);
        continue;
      }
      const appended = await this.appendUrl(
        kind,
        segment.url,
        segment.startMs,
        segment.durationMs,
        revision,
        signal,
      );
      if (!appended) return "deferred";
    }
    return "filled";
  }

  /**
   * Appends one init or segment once. A fill that reaches a segment another fill is still appending (the startup fill
   * goes on after playback starts) waits for it instead of appending it a second time; each track keeps its order.
   */
  private async appendUrl(
    kind: TrackKind,
    url: string,
    startMs: number,
    durationMs: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = `${kind}:${url}`;
    const running = this.appending.get(key);
    if (running) return running;
    const task = this.appendUrlOnce(kind, url, startMs, durationMs, revision, signal);
    this.appending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.appending.get(key) === task) this.appending.delete(key);
    }
  }

  private async appendUrlOnce(
    kind: TrackKind,
    url: string,
    startMs: number,
    durationMs: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.ensureActive(revision, signal);
    const key = `${kind}:${url}`;
    if (this.appended.has(key)) {
      if (durationMs <= 0) return true;
      if (this.isBuffered(kind, startMs, startMs + durationMs, APPENDED_RANGE_TOLERANCE_MS)) {
        this.recheckAttempts.delete(key);
        return true;
      }
      const retries = (this.recheckAttempts.get(key) ?? 0) + 1;
      this.recheckAttempts.set(key, retries);
      if (retries > 1) {
        return true;
      }
      this.appended.delete(key);
    }
    const result =
      durationMs > 0 && !this.primed.has(url)
        ? await this.streamAppend(kind, url, revision, signal)
        : await this.wholeAppend(kind, url, revision, signal);
    this.ensureActive(revision, signal);
    if (result === "deferred") return false;
    this.appended.add(key);
    this.emitter.emit({ type: "segment", kind, url, startMs, durationMs });
    return true;
  }

  private async wholeAppend(
    kind: TrackKind,
    url: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<AppendResult> {
    const bytes = await this.segmentBytes(url, signal);
    this.ensureActive(revision, signal);
    return this.media.append(kind, bytes);
  }

  /**
   * Appends a media segment part by part as the server relays it from YouTube, so its first frames decode before
   * its end. A response that stops part way, or a full buffer, leaves half a segment in the parser: it is reset,
   * then the segment comes whole the usual way (or waits, when the buffer is full).
   */
  private async streamAppend(
    kind: TrackKind,
    url: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<AppendResult> {
    let deferred = false;
    try {
      await fetchSegmentBytes(
        this.http,
        url,
        this.pollLimit,
        signal,
        this.http.retryTiming,
        async (chunk) => {
          this.ensureActive(revision, signal);
          if ((await this.media.append(kind, chunk)) === "deferred") {
            deferred = true;
            throw new Error("SourceBuffer full");
          }
        },
      );
      return "appended";
    } catch (error) {
      if (!(error instanceof PartialSegmentError)) throw error;
      await this.media.resetParser(kind);
      this.ensureActive(revision, signal);
      return deferred ? "deferred" : this.wholeAppend(kind, url, revision, signal);
    }
  }

  private async segmentBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const primed = this.primed.get(url);
    this.primed.delete(url);
    const download = () =>
      fetchSegmentBytes(this.http, url, this.pollLimit, signal, this.http.retryTiming);
    if (!primed) return download();
    return primed.catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return download();
    });
  }

  private isBuffered(
    kind: TrackKind,
    startMs: number,
    endMs: number,
    toleranceMs = BUFFERED_RANGE_TOLERANCE_MS,
  ): boolean {
    if (endMs <= startMs) return false;
    return this.media
      .bufferedRanges()
      .some((range) => coversSegment(range, kind, startMs, endMs, toleranceMs));
  }

  private ensureActive(revision: number, signal?: AbortSignal): void {
    if (revision !== this.revision || signal?.aborted) {
      throw new DOMException("Operation aborted", "AbortError");
    }
  }
}

function primedSegmentUrls(segments: ManifestSegment[], fromMs: number, goalMs: number): string[] {
  return segments
    .filter((segment) => segment.startMs + segment.durationMs > fromMs && segment.startMs <= goalMs)
    .map((segment) => segment.url);
}

function coversSegment(
  range: MediaBufferedRange,
  kind: TrackKind,
  startMs: number,
  endMs: number,
  toleranceMs: number,
): boolean {
  return (
    range.kind === kind &&
    range.startMs <= startMs + toleranceMs &&
    range.endMs >= endMs - toleranceMs
  );
}
