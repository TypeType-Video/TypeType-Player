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
