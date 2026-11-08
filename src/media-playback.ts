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

export async function waitForNativeSeek(
  video: Pick<HTMLVideoElement, "seeking"> & {
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (!video.seeking || typeof video.addEventListener !== "function") return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener?.("seeked", onSeeked);
      signal?.removeEventListener("abort", onAbort);
    };
    video.addEventListener?.("seeked", onSeeked, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
