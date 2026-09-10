import type { EventEmitter } from "./event-emitter";
import type { HttpClient } from "./http-client";
import type { ManifestSegment, PlaybackManifest } from "./manifest";
import type { MediaBufferedRange, MediaSourceController } from "./media-source-controller";
import { fetchSegmentBytes } from "./segment-fetcher";
import type { TrackKind } from "./types";

const BUFFERED_RANGE_TOLERANCE_MS = 50;

export class SegmentScheduler {
  private readonly appended = new Set<string>();
  private revision = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly media: Pick<MediaSourceController, "append" | "bufferedRanges">,
    private readonly emitter: EventEmitter,
    private readonly pollLimit: number,
  ) {}

  reset(): void {
    this.revision += 1;
    this.appended.clear();
  }

  async appendInit(manifest: PlaybackManifest, signal?: AbortSignal): Promise<void> {
    const revision = this.revision;
    const tasks = [this.appendUrl("audio", manifest.audio.initUrl, 0, 0, revision, signal)];
    if (manifest.video) {
      tasks.push(this.appendUrl("video", manifest.video.initUrl, 0, 0, revision, signal));
    }
    await Promise.all(tasks);
  }

  async fill(
    manifest: PlaybackManifest,
    currentMs: number,
    goalMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const revision = this.revision;
    const tasks = [
      this.fillTrack("audio", manifest.audio.segments, currentMs, goalMs, revision, signal),
    ];
    if (manifest.video) {
      tasks.push(
        this.fillTrack("video", manifest.video.segments, currentMs, goalMs, revision, signal),
      );
    }
    await Promise.all(tasks);
  }

  private async fillTrack(
    kind: TrackKind,
    segments: ManifestSegment[],
    currentMs: number,
    goalMs: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidates = segments
      .filter(
        (segment) => segment.startMs + segment.durationMs > currentMs && segment.startMs <= goalMs,
      )
      .sort((left, right) => left.startMs - right.startMs);
    for (const segment of candidates) {
      const segmentEndMs = segment.startMs + segment.durationMs;
      if (this.isBuffered(kind, segment.startMs, segmentEndMs)) continue;
      await this.appendUrl(
        kind,
        segment.url,
        segment.startMs,
        segment.durationMs,
        revision,
        signal,
      );
    }
  }

  private async appendUrl(
    kind: TrackKind,
    url: string,
    startMs: number,
    durationMs: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.ensureActive(revision, signal);
    const key = `${kind}:${url}`;
    if (this.appended.has(key)) {
      if (durationMs <= 0 || this.isBuffered(kind, startMs, startMs + durationMs)) return;
      this.appended.delete(key);
    }
    const bytes = await fetchSegmentBytes(this.http, url, this.pollLimit, signal);
    this.ensureActive(revision, signal);
    await this.media.append(kind, bytes);
    this.ensureActive(revision, signal);
    this.appended.add(key);
    this.emitter.emit({ type: "segment", kind, url, startMs, durationMs });
  }

  private isBuffered(kind: TrackKind, startMs: number, endMs: number): boolean {
    if (endMs <= startMs) return false;
    return this.media.bufferedRanges().some((range) => coversSegment(range, kind, startMs, endMs));
  }

  private ensureActive(revision: number, signal?: AbortSignal): void {
    if (revision !== this.revision || signal?.aborted) {
      throw new DOMException("Operation aborted", "AbortError");
    }
  }
}

function coversSegment(
  range: MediaBufferedRange,
  kind: TrackKind,
  startMs: number,
  endMs: number,
): boolean {
  return (
    range.kind === kind &&
    range.startMs <= startMs + BUFFERED_RANGE_TOLERANCE_MS &&
    range.endMs >= endMs - BUFFERED_RANGE_TOLERANCE_MS
  );
}
