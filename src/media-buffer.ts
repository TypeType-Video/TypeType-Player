const RANGE_TOLERANCE_SECONDS = 0.05;
const MIN_SEEK_BUFFER_MS = 250;

export function bufferedEndAtCurrentTime(
  video: Pick<HTMLVideoElement, "buffered" | "currentTime">,
): number {
  const range = bufferedRangeAt(video.buffered, video.currentTime);
  return range ? Math.round(range.end * 1000) : 0;
}

export function seekWithinBufferedMedia(
  video: Pick<HTMLVideoElement, "buffered" | "currentTime">,
  targetMs: number,
): boolean {
  const safeTargetMs = Math.max(0, Math.round(targetMs));
  const range = bufferedRangeAt(video.buffered, safeTargetMs / 1000);
  if (!range || safeTargetMs > range.end * 1000 - MIN_SEEK_BUFFER_MS) return false;
  video.currentTime = safeTargetMs / 1000;
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
