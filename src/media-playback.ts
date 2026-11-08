import { bufferedRangeAt } from "./media-buffer";

type PlayableMedia = Pick<HTMLVideoElement, "pause" | "play">;

export async function playMedia(video: PlayableMedia, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  const pending = video.play();
  if (!signal) return pending;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      video.pause();
      void pending.then(
        () => video.pause(),
        () => undefined,
      );
      reject(abortError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function tryResumePlayback(
  video: PlayableMedia,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await playMedia(video, signal);
    return true;
  } catch (error) {
    if (isPlaybackPermissionError(error)) return false;
    throw error;
  }
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

export function isPlaybackPermissionError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}

const NATIVE_SEEK_TIMEOUT_MS = 2_000;

type SeekingMedia = Pick<HTMLVideoElement, "seeking"> & {
  currentTime?: number;
  buffered?: TimeRanges;
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

// A seek completes only once its position has media, which the loop appends after this wait:
// waiting on an unbuffered position would never end.
export async function waitForNativeSeek(
  video: SeekingMedia,
  signal?: AbortSignal,
  timeoutMs = NATIVE_SEEK_TIMEOUT_MS,
): Promise<void> {
  if (!video.seeking || typeof video.addEventListener !== "function" || signal?.aborted) return;
  if (
    video.buffered &&
    typeof video.currentTime === "number" &&
    !bufferedRangeAt(video.buffered, video.currentTime)
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener?.("seeked", finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener?.("seeked", finish, { once: true });
    signal?.addEventListener("abort", finish, { once: true });
  });
}
