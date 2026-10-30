type MediaStateSnapshot = {
  autoplay: boolean;
  defaultPlaybackRate: number;
  muted: boolean;
  opacity: string | null;
  playbackRate: number;
};

type LifecycleTargets = {
  document?: EventTarget;
  window?: EventTarget;
};

export class TransientMediaState {
  private snapshot: MediaStateSnapshot | null = null;
  private revision = 0;
  private heldForPreroll = false;

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
      opacity: this.video.style?.opacity ?? null,
      playbackRate: this.video.playbackRate,
    };
    this.video.defaultPlaybackRate = this.snapshot.playbackRate;
    return () => {
      if (revision === this.revision) this.restore();
    };
  }

  begin(): () => void {
    const restore = this.preserve();
    this.applyPrerollOverride();
    return restore;
  }

  beginAttachment(): () => void {
    const restore = this.preserve();
    this.video.muted = true;
    if (this.video.style) this.video.style.opacity = "0";
    return restore;
  }

  holdForPreroll(): void {
    if (this.active) return;
    this.preserve();
    this.video.muted = true;
    if (this.video.style) this.video.style.opacity = "0";
    this.heldForPreroll = true;
  }

  releasePrerollHold(): void {
    if (this.heldForPreroll) this.restore();
  }

  beginPreroll(playbackRate = 16): () => void {
    if (!this.active || this.heldForPreroll) {
      const restore = this.heldForPreroll ? this.adoptPrerollHold() : this.preserve();
      this.applyPrerollOverride(playbackRate);
      return restore;
    }
    this.applyPrerollOverride(playbackRate);
    return () => undefined;
  }

  private adoptPrerollHold(): () => void {
    this.heldForPreroll = false;
    const revision = this.revision;
    return () => {
      if (revision === this.revision) this.restore();
    };
  }

  private applyPrerollOverride(playbackRate = 16): void {
    this.video.muted = true;
    if (this.video.style) this.video.style.opacity = "0";
    this.video.playbackRate = playbackRate;
    this.video.autoplay = true;
  }

  restore(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.video.defaultPlaybackRate = snapshot.defaultPlaybackRate;
    this.video.playbackRate = snapshot.playbackRate;
    this.video.muted = snapshot.muted;
    if (snapshot.opacity !== null && this.video.style) this.video.style.opacity = snapshot.opacity;
    this.video.autoplay = snapshot.autoplay;
    this.snapshot = null;
    this.heldForPreroll = false;
    this.revision += 1;
  }
}

export function suspendAutoplay(video: HTMLVideoElement): () => void {
  const autoplay = video.autoplay;
  video.autoplay = false;
  return () => {
    video.autoplay = autoplay;
  };
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
