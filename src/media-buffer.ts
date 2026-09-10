const RANGE_TOLERANCE_SECONDS = 0.05;
const TRACK_RANGE_TOLERANCE_MS = 50;
const MIN_SEEK_BUFFER_MS = 250;
const RANGE_ENTRY_OFFSET_SECONDS = 0.001;

export type BufferedTrackRange = {
  kind: "audio" | "video";
  startMs: number;
  endMs: number;
};

export function bufferedEndAtCurrentTime(
  video: Pick<HTMLVideoElement, "buffered" | "currentTime">,
): number {
  const range = bufferedRangeAt(video.buffered, video.currentTime);
  return range ? Math.round(range.end * 1000) : 0;
}

export function bufferedEndAtCurrentTrackRanges(
  ranges: readonly BufferedTrackRange[],
  currentMs: number,
  hasVideo: boolean,
): number {
  const kinds: BufferedTrackRange["kind"][] = hasVideo ? ["audio", "video"] : ["audio"];
  const ends = kinds.map((kind) => {
    const range = ranges.find(
      (candidate) =>
        candidate.kind === kind &&
        candidate.startMs <= currentMs + TRACK_RANGE_TOLERANCE_MS &&
        candidate.endMs > currentMs - TRACK_RANGE_TOLERANCE_MS,
    );
    return range?.endMs ?? null;
  });
  if (ends.some((endMs) => endMs === null)) return 0;
  const completeEnds = ends.filter((endMs): endMs is number => endMs !== null);
  return Math.min(...completeEnds);
}

export function seekWithinBufferedMedia(
  video: Pick<HTMLVideoElement, "buffered" | "currentTime">,
  targetMs: number,
): boolean {
  if (!canSeekWithinBufferedMedia(video, targetMs)) return false;
  video.currentTime = Math.max(0, Math.round(targetMs)) / 1000;
  return true;
}

export function canSeekWithinBufferedMedia(
  video: Pick<HTMLVideoElement, "buffered">,
  targetMs: number,
): boolean {
  const safeTargetMs = Math.max(0, Math.round(targetMs));
  const range = bufferedRangeAt(video.buffered, safeTargetMs / 1000);
  return range !== null && safeTargetMs <= range.end * 1000 - MIN_SEEK_BUFFER_MS;
}

export function canUseBufferedMediaSeek(
  video: Pick<HTMLVideoElement, "buffered"> & { webkitSupportsFullscreen?: boolean },
  targetMs: number,
): boolean {
  return (
    typeof video.webkitSupportsFullscreen !== "boolean" &&
    canSeekWithinBufferedMedia(video, targetMs)
  );
}

export function alignPlayheadToBufferedRange(
  video: Pick<HTMLVideoElement, "buffered" | "currentTime">,
): boolean {
  const range = bufferedRangeAt(video.buffered, video.currentTime);
  if (!range || video.currentTime >= range.start || range.end <= range.start) return false;
  video.currentTime = Math.min(range.start + RANGE_ENTRY_OFFSET_SECONDS, range.end);
  return true;
}

export function bufferedRangeAt(ranges: TimeRanges, positionSeconds: number) {
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (
      positionSeconds >= start - RANGE_TOLERANCE_SECONDS &&
      positionSeconds < end + RANGE_TOLERANCE_SECONDS
    ) {
      return { start, end };
    }
  }
  return null;
}
