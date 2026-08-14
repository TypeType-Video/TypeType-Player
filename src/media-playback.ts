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
