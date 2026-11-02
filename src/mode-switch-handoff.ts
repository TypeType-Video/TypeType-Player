import type { PlaybackManifest } from "./manifest";
import type { MediaBufferedRange } from "./media-source-controller";
import type { TrackKind } from "./types";

const PREPARE_LEAD_MS = 600;
const PRIME_MARGIN_MS = 120;
const KEYFRAME_WAIT_MS = 2_500;
const BUFFER_SAFETY_MS = 250;
const LATE_HANDOFF_TOLERANCE_MS = 60;
const PLAYHEAD_POLL_MS = 10;
const STALL_HANDOFF_MS = 60;
const HAVE_FUTURE_DATA = 3;

export const MODE_SWITCH_BUFFER_MS = 1_000;

export type ModeHandoffPlan = {
  targetMs: number;
  bufferedEndMs: number;
};

/** Plans where a mode switch can take over while the current media keeps playing. */
export function planModeHandoff(
  ranges: MediaBufferedRange[],
  nowMs: number,
  kinds: TrackKind[],
): ModeHandoffPlan | null {
  const bufferedEndMs = playheadBufferedEndMs(ranges, nowMs, kinds);
  if (bufferedEndMs === null) return null;
  const latestMs = bufferedEndMs - BUFFER_SAFETY_MS;
  if (latestMs - nowMs < PRIME_MARGIN_MS * 2) return null;
  return { targetMs: Math.min(nowMs + PREPARE_LEAD_MS, latestMs), bufferedEndMs };
}

/** Picks the swap point, preferring a video keyframe close enough to avoid a decode preroll. */
export function chooseHandoffMs(
  manifest: PlaybackManifest,
  plan: ModeHandoffPlan,
  nowMs: number,
): number {
  const earliestMs = Math.max(plan.targetMs, nowMs + PRIME_MARGIN_MS);
  const latestMs = plan.bufferedEndMs - BUFFER_SAFETY_MS;
  if (earliestMs > latestMs) return nowMs;
  if (!manifest.video) return earliestMs;
  const keyframeMs = manifest.video.segments
    .map((segment) => segment.startMs)
    .filter((startMs) => startMs >= earliestMs && startMs <= latestMs)
    .filter((startMs) => startMs - earliestMs <= KEYFRAME_WAIT_MS)
    .sort((left, right) => left - right)[0];
  return keyframeMs ?? earliestMs;
}

/** Waits until the playing media reaches the swap point, and reports where it really is. */
export async function waitForPlayhead(
  video: Pick<HTMLVideoElement, "currentTime" | "paused" | "ended" | "readyState">,
  handoffMs: number,
  signal: AbortSignal,
): Promise<number> {
  let stalledSinceMs: number | null = null;
  let lastTime = video.currentTime;
  while (!video.paused && !video.ended && video.currentTime * 1000 < handoffMs) {
    await sleep(PLAYHEAD_POLL_MS, signal);
    const stalled = video.readyState < HAVE_FUTURE_DATA || video.currentTime === lastTime;
    lastTime = video.currentTime;
    if (!stalled) {
      stalledSinceMs = null;
      continue;
    }
    stalledSinceMs ??= performance.now();
    if (performance.now() - stalledSinceMs >= STALL_HANDOFF_MS) break;
  }
  const playheadMs = Math.round(video.currentTime * 1000);
  if (playheadMs < handoffMs) return playheadMs;
  return playheadMs - handoffMs > LATE_HANDOFF_TOLERANCE_MS ? playheadMs : handoffMs;
}

export function sessionTrackKinds(session: { manifest: PlaybackManifest }): TrackKind[] {
  return session.manifest.video ? ["audio", "video"] : ["audio"];
}

export function firstSegmentStartMs(manifest: PlaybackManifest): number | null {
  const starts = [...manifest.audio.segments, ...(manifest.video?.segments ?? [])].map(
    (segment) => segment.startMs,
  );
  return starts.length > 0 ? Math.min(...starts) : null;
}

function playheadBufferedEndMs(
  ranges: MediaBufferedRange[],
  nowMs: number,
  kinds: TrackKind[],
): number | null {
  let endMs: number | null = null;
  for (const kind of kinds) {
    const range = ranges.find(
      (item) => item.kind === kind && item.startMs <= nowMs && item.endMs > nowMs,
    );
    if (!range) return null;
    endMs = endMs === null ? range.endMs : Math.min(endMs, range.endMs);
  }
  return endMs;
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Operation aborted", "AbortError"));
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new DOMException("Operation aborted", "AbortError"));
    }
  });
}
