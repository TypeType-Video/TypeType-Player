import type { PlaybackManifest } from "./manifest";

const TIMING_TOLERANCE_SECONDS = 0.001;

export class MediaSourceTiming {
  private liveRange: [number, number] | null = null;

  apply(mediaSource: MediaSource, manifest: PlaybackManifest): void {
    const live = manifest.live;
    if (live?.active) {
      this.setDuration(mediaSource, Number.POSITIVE_INFINITY);
      this.setLiveRange(mediaSource, live.seekableStartMs / 1000, live.seekableEndMs / 1000);
      return;
    }
    this.clearLiveRange(mediaSource);
    const duration = manifest.durationMs > 0 ? manifest.durationMs / 1000 : Number.NaN;
    this.setDuration(mediaSource, duration);
  }

  reset(): void {
    this.liveRange = null;
  }

  private setDuration(mediaSource: MediaSource, duration: number): void {
    if (sameNumber(mediaSource.duration, duration)) return;
    mediaSource.duration = duration;
  }

  private setLiveRange(mediaSource: MediaSource, start: number, end: number): void {
    if (sameRange(this.liveRange, start, end)) return;
    if (typeof mediaSource.setLiveSeekableRange === "function") {
      mediaSource.setLiveSeekableRange(start, end);
    }
    this.liveRange = [start, end];
  }

  private clearLiveRange(mediaSource: MediaSource): void {
    if (this.liveRange === null) return;
    if (typeof mediaSource.clearLiveSeekableRange === "function") {
      mediaSource.clearLiveSeekableRange();
    }
    this.liveRange = null;
  }
}

function sameNumber(left: number, right: number): boolean {
  if (left === right) return true;
  if (Number.isNaN(left) && Number.isNaN(right)) return true;
  return Math.abs(left - right) <= TIMING_TOLERANCE_SECONDS;
}

function sameRange(range: [number, number] | null, start: number, end: number): boolean {
  return range !== null && sameNumber(range[0], start) && sameNumber(range[1], end);
}
