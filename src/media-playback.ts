export async function tryResumePlayback(video: Pick<HTMLVideoElement, "play">): Promise<boolean> {
  try {
    await video.play();
    return true;
  } catch (error) {
    if (isPlaybackPermissionError(error)) return false;
    throw error;
  }
}

export function isPlaybackPermissionError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}
