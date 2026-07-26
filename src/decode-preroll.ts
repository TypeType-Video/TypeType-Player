import type { PlaybackManifest } from "./manifest";
import { tryResumePlayback } from "./media-playback";
import { TransientMediaState } from "./transient-media-state";

const TARGET_TOLERANCE_MS = 80;
const TARGET_BOUNDARY_TOLERANCE_MS = 1;
const HAVE_CURRENT_DATA = 2;
const MIN_PREROLL_TIMEOUT_MS = 5_000;
const MAX_PREROLL_TIMEOUT_MS = 15_000;
const SNAP_TIMEOUT_MS = 2_000;
const SNAP_TOLERANCE_MS = 20;

export function decodeStartMs(manifest: PlaybackManifest, targetMs: number): number {
  if (!manifest.video) return targetMs;
  const audio = manifest.audio.segments.find(
    (item) => item.startMs <= targetMs && item.startMs + item.durationMs > targetMs,
  );
  if (audio && Math.abs(audio.startMs - targetMs) <= TARGET_BOUNDARY_TOLERANCE_MS) return targetMs;
  const video = manifest.video.segments.find(
    (item) => item.startMs <= targetMs && item.startMs + item.durationMs > targetMs,
  );
  return video?.startMs ?? targetMs;
}

export async function runDecodePreroll(
  video: HTMLVideoElement,
  targetMs: number,
  resumePlayback: boolean,
  signal: AbortSignal,
  requireFrame = false,
  transientState = new TransientMediaState(video),
): Promise<void> {
  ensureNotAborted(signal);
  const targetReached = video.currentTime * 1000 >= targetMs - TARGET_TOLERANCE_MS;
  if (targetReached && (!requireFrame || video.readyState >= HAVE_CURRENT_DATA)) {
    const distanceMs = Math.abs(video.currentTime * 1000 - targetMs);
    const exact = distanceMs <= SNAP_TOLERANCE_MS;
    const resumeWithinTolerance = resumePlayback && distanceMs <= TARGET_TOLERANCE_MS;
    if (!exact && !resumeWithinTolerance) await snapToTarget(video, targetMs, signal);
    if (resumePlayback && video.paused) {
      await tryResumePlayback(video);
      ensureNotAborted(signal);
    }
    return;
  }
  const restoreMediaState = transientState.begin();
  let pausedForSnap = false;
  try {
    await video.play();
    await waitForTarget(video, targetMs, signal);
    if (!resumePlayback) {
      video.pause();
      pausedForSnap = true;
      await snapToTarget(video, targetMs, signal);
    }
  } finally {
    restoreMediaState();
    if (!resumePlayback) {
      if (!pausedForSnap) video.pause();
    } else if (!signal.aborted) {
      await tryResumePlayback(video);
      ensureNotAborted(signal);
    }
  }
}

function snapToTarget(
  video: HTMLVideoElement,
  targetMs: number,
  signal: AbortSignal,
): Promise<void> {
  ensureNotAborted(signal);
  const exact = Math.abs(video.currentTime * 1000 - targetMs) <= SNAP_TOLERANCE_MS;
  if (exact && video.readyState >= HAVE_CURRENT_DATA) return Promise.resolve();
  video.currentTime = targetMs / 1000;
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const poll = () => {
      if (signal.aborted) return reject(new DOMException("Operation aborted", "AbortError"));
      if (video.error) return reject(new Error(video.error.message));
      const exact = Math.abs(video.currentTime * 1000 - targetMs) <= SNAP_TOLERANCE_MS;
      if (exact && video.readyState >= HAVE_CURRENT_DATA) return resolve();
      if (performance.now() - startedAt >= SNAP_TIMEOUT_MS)
        return reject(new Error("Seek target snap timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function waitForTarget(
  video: HTMLVideoElement,
  targetMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decodeDistanceMs = Math.max(0, targetMs - video.currentTime * 1000);
    const timeoutMs = Math.min(
      MAX_PREROLL_TIMEOUT_MS,
      Math.max(MIN_PREROLL_TIMEOUT_MS, decodeDistanceMs * 2),
    );
    const startedAt = performance.now();
    const poll = () => {
      if (signal.aborted) return reject(new DOMException("Operation aborted", "AbortError"));
      if (video.error) return reject(new Error(video.error.message));
      if (video.currentTime * 1000 >= targetMs - TARGET_TOLERANCE_MS) return resolve();
      if (performance.now() - startedAt >= timeoutMs)
        return reject(new Error("Decode preroll timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}
