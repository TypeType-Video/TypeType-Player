type MediaStateSnapshot = {
  autoplay: boolean;
  defaultPlaybackRate: number;
  muted: boolean;
  playbackRate: number;
};

type LifecycleTargets = {
  document?: EventTarget;
  window?: EventTarget;
};

export class TransientMediaState {
  private snapshot: MediaStateSnapshot | null = null;
  private revision = 0;

  constructor(private readonly video: HTMLVideoElement) {}

  get active(): boolean {
    return this.snapshot !== null;
  }

  preserve(): () => void {
    this.restore();
    const revision = ++this.revision;
    this.snapshot = {
      autoplay: this.video.autoplay,
      defaultPlaybackRate: this.video.defaultPlaybackRate,
      muted: this.video.muted,
      playbackRate: this.video.playbackRate,
    };
    this.video.defaultPlaybackRate = this.snapshot.playbackRate;
    return () => {
      if (revision === this.revision) this.restore();
    };
  }

  begin(): () => void {
    const restore = this.preserve();
    this.video.muted = true;
    this.video.playbackRate = 16;
    this.video.autoplay = true;
    return restore;
  }

  restore(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.video.defaultPlaybackRate = snapshot.defaultPlaybackRate;
    this.video.playbackRate = snapshot.playbackRate;
    this.video.muted = snapshot.muted;
    this.video.autoplay = snapshot.autoplay;
    this.snapshot = null;
    this.revision += 1;
  }
}

export function observePageSuspension(
  restore: () => void,
  targets: LifecycleTargets = browserLifecycleTargets(),
): () => void {
  const onSuspend = () => restore();
  targets.window?.addEventListener("pagehide", onSuspend);
  targets.document?.addEventListener("freeze", onSuspend);
  return () => {
    targets.window?.removeEventListener("pagehide", onSuspend);
    targets.document?.removeEventListener("freeze", onSuspend);
  };
}

function browserLifecycleTargets(): LifecycleTargets {
  return {
    ...(typeof document === "undefined" ? {} : { document }),
    ...(typeof window === "undefined" ? {} : { window }),
  };
}
