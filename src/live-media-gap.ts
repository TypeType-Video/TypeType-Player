const EDGE_TOLERANCE_SECONDS = 0.05;
const MIN_FUTURE_RANGE_SECONDS = 0.25;
const MAX_LIVE_GAP_SECONDS = 60.25;
const RANGE_ENTRY_OFFSET_SECONDS = 0.01;

type LiveGapMedia = Pick<HTMLVideoElement, "buffered" | "currentTime" | "paused">;

export function skipBufferedLiveGap(video: LiveGapMedia): boolean {
  if (video.paused || !Number.isFinite(video.currentTime)) return false;
  const current = video.currentTime;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (current >= start - EDGE_TOLERANCE_SECONDS && current < end - EDGE_TOLERANCE_SECONDS) {
      return false;
    }
    const gap = start - current;
    if (gap <= EDGE_TOLERANCE_SECONDS) continue;
    if (gap > MAX_LIVE_GAP_SECONDS) return false;
    if (end - start < MIN_FUTURE_RANGE_SECONDS) return false;
    video.currentTime = Math.min(start + RANGE_ENTRY_OFFSET_SECONDS, end - EDGE_TOLERANCE_SECONDS);
    return true;
  }
  return false;
}
