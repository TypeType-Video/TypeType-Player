import type { PlaybackManifest } from "./manifest";
import { alignPlayheadToBufferedRange, bufferedRangeAt } from "./media-buffer";
import { playMedia, tryResumePlayback } from "./media-playback";
import { TransientMediaState } from "./transient-media-state";

const TARGET_TOLERANCE_MS = 80;
const TARGET_BOUNDARY_TOLERANCE_MS = 1;
const HAVE_CURRENT_DATA = 2;
const MIN_PREROLL_TIMEOUT_MS = 5_000;
const MAX_PREROLL_TIMEOUT_MS = 15_000;
const SNAP_TIMEOUT_MS = 2_000;
const SNAP_TOLERANCE_MS = 20;
const DEFAULT_PREROLL_RATE = 16;
const WEBKIT_PREROLL_RATE = 1;

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
    let resumeAttempted = false;
    if (!exact && !resumeWithinTolerance) {
      resumeAttempted = await snapToTarget(video, targetMs, signal, resumePlayback);
    }
    if (resumePlayback && !resumeAttempted && video.paused) {
      await tryResumePlayback(video, signal);
      ensureNotAborted(signal);
    }
    return;
  }
  const restoreMediaState = transientState.beginPreroll(prerollRate(video));
  let pausedAtTarget = false;
  try {
    await waitForTarget(video, targetMs, signal);
    const distanceMs = Math.abs(video.currentTime * 1000 - targetMs);
    if (!resumePlayback) {
      video.pause();
      pausedAtTarget = true;
      ensureNotAborted(signal);
      if (distanceMs > TARGET_TOLERANCE_MS) {
        await snapToTarget(video, targetMs, signal);
      }
    } else if (distanceMs > TARGET_TOLERANCE_MS) {
      await snapToTarget(video, targetMs, signal, true);
    }
  } finally {
    restoreMediaState();
    if (!resumePlayback) {
      if (!pausedAtTarget) video.pause();
    } else if (!signal.aborted && video.paused) {
      await tryResumePlayback(video, signal);
      ensureNotAborted(signal);
    }
  }
}

function prerollRate(video: HTMLVideoElement): number {
  const webkitVideo = video as HTMLVideoElement & { webkitSupportsFullscreen?: boolean };
  return typeof webkitVideo.webkitSupportsFullscreen === "boolean"
    ? WEBKIT_PREROLL_RATE
    : DEFAULT_PREROLL_RATE;
}

async function snapToTarget(
  video: HTMLVideoElement,
  targetMs: number,
  signal: AbortSignal,
  resumePlayback = false,
): Promise<boolean> {
  ensureNotAborted(signal);
  const exact = Math.abs(video.currentTime * 1000 - targetMs) <= SNAP_TOLERANCE_MS;
  if (exact && !video.seeking && video.readyState >= HAVE_CURRENT_DATA) return false;
  if (resumePlayback && !video.paused) video.pause();
  video.currentTime = targetMs / 1000;
  let resumeAttempted = false;
  if (resumePlayback && video.paused) {
    resumeAttempted = true;
    await tryResumePlayback(video, signal);
    ensureNotAborted(signal);
  }
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const poll = () => {
      if (signal.aborted) return reject(new DOMException("Operation aborted", "AbortError"));
      if (video.error) return reject(new Error(video.error.message));
      const exact = Math.abs(video.currentTime * 1000 - targetMs) <= SNAP_TOLERANCE_MS;
      if (exact && !video.seeking && video.readyState >= HAVE_CURRENT_DATA) {
        return resolve(resumeAttempted);
      }
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

async function waitForTarget(
  video: HTMLVideoElement,
  targetMs: number,
  signal: AbortSignal,
): Promise<void> {
  const decodeDistanceMs = Math.max(0, targetMs - video.currentTime * 1000);
  const timeoutMs = Math.min(
    MAX_PREROLL_TIMEOUT_MS,
    Math.max(MIN_PREROLL_TIMEOUT_MS, decodeDistanceMs * 2),
  );
  const startedAt = performance.now();
  let playStarted = false;
  while (true) {
    ensureNotAborted(signal);
    if (video.error) throw new Error(video.error.message);
    alignPlayheadToBufferedRange(video);
    const targetReached = video.currentTime * 1000 >= targetMs - TARGET_TOLERANCE_MS;
    const bufferedAtPlayhead = bufferedRangeAt(video.buffered, video.currentTime) !== null;
    if (video.readyState < HAVE_CURRENT_DATA && !targetReached && !bufferedAtPlayhead) {
      if (performance.now() - startedAt >= timeoutMs) throw new Error("Decode preroll timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (!playStarted || (video.paused && !video.seeking)) {
      await playMedia(video, signal);
      playStarted = true;
    }
    if (video.currentTime * 1000 >= targetMs - TARGET_TOLERANCE_MS) return;
    if (performance.now() - startedAt >= timeoutMs) throw new Error("Decode preroll timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
