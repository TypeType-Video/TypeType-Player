import type { EventEmitter } from "./event-emitter";
import type { HttpClient } from "./http-client";
import type { ManifestSegment, PlaybackManifest } from "./manifest";
import type { MediaBufferedRange, MediaSourceController } from "./media-source-controller";
import { fetchSegmentBytes } from "./segment-fetcher";
import type { TrackKind } from "./types";

const BUFFERED_RANGE_TOLERANCE_MS = 50;
const APPENDED_RANGE_TOLERANCE_MS = 450;
const TRACK_PREFETCH_LOOKAHEAD = 1;

export type SegmentFillResult = "filled" | "deferred";

export class SegmentScheduler {
  private readonly appended = new Set<string>();
  private readonly primed = new Map<string, Promise<ArrayBuffer>>();
  private readonly recheckAttempts = new Map<string, number>();
  private readonly pipelineReady = new Set<TrackKind>();
  private readonly fillControllers = new Set<AbortController>();
  private revision = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly media: Pick<MediaSourceController, "append" | "bufferedRanges">,
    private readonly emitter: EventEmitter,
    private readonly pollLimit: number,
  ) {}

  reset(): void {
    this.revision += 1;
    for (const controller of this.fillControllers) controller.abort();
    this.fillControllers.clear();
    this.appended.clear();
    this.recheckAttempts.clear();
    this.pipelineReady.clear();
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
    const prefetched = new Map<number, Promise<ArrayBuffer>>();
    const scope = this.beginFillAbort(signal);
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const segment = candidates[index];
        if (!segment) continue;
        const segmentEndMs = segment.startMs + segment.durationMs;
        if (this.isBuffered(kind, segment.startMs, segmentEndMs)) {
          this.recheckAttempts.delete(`${kind}:${segment.url}`);
          continue;
        }
        const existingBytes = prefetched.get(index);
        if (this.shouldSkipAppended(kind, segment.url, segment.startMs, segment.durationMs)) {
          continue;
        }
        const bytesPromise = existingBytes ?? this.startSegmentFetch(segment.url, scope.signal);
        if (this.pipelineReady.has(kind)) {
          this.prefetchUpcomingSegments(kind, candidates, index + 1, prefetched, scope.signal);
        }
        const appended = await this.appendUrl(
          kind,
          segment.url,
          segment.startMs,
          segment.durationMs,
          revision,
          scope.signal,
          bytesPromise,
        );
        if (!appended) {
          this.pipelineReady.delete(kind);
          return "deferred";
        }
        this.pipelineReady.add(kind);
      }
      return "filled";
    } finally {
      scope.dispose();
    }
  }

  private beginFillAbort(signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    this.fillControllers.add(controller);
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      dispose: () => {
        this.fillControllers.delete(controller);
        signal?.removeEventListener("abort", onExternalAbort);
        controller.abort();
      },
    };
  }

  private prefetchUpcomingSegments(
    kind: TrackKind,
    candidates: ManifestSegment[],
    startIndex: number,
    prefetched: Map<number, Promise<ArrayBuffer>>,
    signal?: AbortSignal,
  ): void {
    let scheduled = 0;
    for (
      let nextIndex = startIndex;
      nextIndex < candidates.length && scheduled < TRACK_PREFETCH_LOOKAHEAD;
      nextIndex += 1
    ) {
      if (prefetched.has(nextIndex)) {
        scheduled += 1;
        continue;
      }
      const next = candidates[nextIndex];
      if (!next) continue;
      const key = `${kind}:${next.url}`;
      if (
        this.isBuffered(kind, next.startMs, next.startMs + next.durationMs) ||
        this.appended.has(key) ||
        this.primed.has(next.url)
      ) {
        continue;
      }
      prefetched.set(nextIndex, this.startSegmentFetch(next.url, signal));
      scheduled += 1;
    }
  }

  private startSegmentFetch(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const bytes = this.segmentBytes(url, signal);
    bytes.catch(() => undefined);
    return bytes;
  }

  private shouldSkipAppended(
    kind: TrackKind,
    url: string,
    startMs: number,
    durationMs: number,
  ): boolean {
    const key = `${kind}:${url}`;
    if (!this.appended.has(key)) return false;
    if (durationMs <= 0) return true;
    if (this.isBuffered(kind, startMs, startMs + durationMs, APPENDED_RANGE_TOLERANCE_MS)) {
      this.recheckAttempts.delete(key);
      return true;
    }
    const retries = (this.recheckAttempts.get(key) ?? 0) + 1;
    this.recheckAttempts.set(key, retries);
    if (retries > 1) return true;
    this.appended.delete(key);
    return false;
  }

  private async appendUrl(
    kind: TrackKind,
    url: string,
    startMs: number,
    durationMs: number,
    revision: number,
    signal?: AbortSignal,
    prefetchedBytes?: Promise<ArrayBuffer>,
  ): Promise<boolean> {
    this.ensureActive(revision, signal);
    const key = `${kind}:${url}`;
    if (!prefetchedBytes && this.shouldSkipAppended(kind, url, startMs, durationMs)) {
      return true;
    }
    const bytes = await (prefetchedBytes ?? this.segmentBytes(url, signal));
    this.ensureActive(revision, signal);
    const result = await this.media.append(kind, bytes);
    this.ensureActive(revision, signal);
    if (result === "deferred") return false;
    this.appended.add(key);
    this.emitter.emit({ type: "segment", kind, url, startMs, durationMs });
    return true;
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
