type VisibilityTarget = EventTarget & {
  visibilityState?: DocumentVisibilityState;
};

type MediaTarget = EventTarget & {
  paused?: boolean;
};

type PlaybackLifecycleTargets = {
  document?: VisibilityTarget;
  page?: EventTarget;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  video: MediaTarget;
};

type PlaybackLifecycleCallbacks = {
  active: (active: boolean) => void;
  wake: () => void;
};

export function observePlaybackLifecycle(
  callbacks: PlaybackLifecycleCallbacks,
  targets: PlaybackLifecycleTargets,
): () => void {
  let pictureInPicture = false;
  const cancelScheduled = new Set<() => void>();
  const schedule =
    targets.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const hidden = () => targets.document?.visibilityState === "hidden";
  const active = () => pictureInPicture || !hidden() || targets.video.paused === false;
  const sync = () => {
    const playbackActive = active();
    callbacks.active(playbackActive);
    if (playbackActive) callbacks.wake();
  };
  const onEnterPictureInPicture = () => {
    pictureInPicture = true;
    sync();
  };
  const onLeavePictureInPicture = () => {
    pictureInPicture = false;
    sync();
  };
  const onMediaProgress = () => {
    if ((pictureInPicture || hidden()) && active()) callbacks.wake();
  };
  const wakeIfActive = () => {
    if (active()) callbacks.wake();
  };
  const settle = () => {
    for (const cancel of cancelScheduled) cancel();
    cancelScheduled.clear();
    sync();
    for (const delayMs of [120, 600]) {
      let cancel: () => void = () => undefined;
      cancel = schedule(() => {
        cancelScheduled.delete(cancel);
        sync();
      }, delayMs);
      cancelScheduled.add(cancel);
    }
  };

  targets.video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
  targets.video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
  targets.video.addEventListener("timeupdate", onMediaProgress);
  targets.video.addEventListener("play", settle);
  targets.video.addEventListener("pause", settle);
  targets.video.addEventListener("waiting", wakeIfActive);
  targets.video.addEventListener("stalled", wakeIfActive);
  targets.document?.addEventListener("visibilitychange", settle);
  targets.document?.addEventListener("resume", settle);
  targets.page?.addEventListener("pageshow", settle);
  targets.page?.addEventListener("focus", settle);
  targets.page?.addEventListener("resize", settle);
  targets.page?.addEventListener("orientationchange", settle);
  sync();

  return () => {
    targets.video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
    targets.video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
    targets.video.removeEventListener("timeupdate", onMediaProgress);
    targets.video.removeEventListener("play", settle);
    targets.video.removeEventListener("pause", settle);
    targets.video.removeEventListener("waiting", wakeIfActive);
    targets.video.removeEventListener("stalled", wakeIfActive);
    targets.document?.removeEventListener("visibilitychange", settle);
    targets.document?.removeEventListener("resume", settle);
    targets.page?.removeEventListener("pageshow", settle);
    targets.page?.removeEventListener("focus", settle);
    targets.page?.removeEventListener("resize", settle);
    targets.page?.removeEventListener("orientationchange", settle);
    for (const cancel of cancelScheduled) cancel();
    cancelScheduled.clear();
  };
}

export function browserPlaybackLifecycleTargets(video: HTMLVideoElement): PlaybackLifecycleTargets {
  return {
    video,
    ...(typeof document === "undefined" ? {} : { document }),
    ...(typeof window === "undefined" ? {} : { page: window }),
  };
}
