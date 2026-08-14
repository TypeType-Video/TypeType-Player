import { tryResumePlayback } from "./media-playback";

export class PlaybackIntent {
  private resume = false;

  get shouldResume(): boolean {
    return this.resume;
  }

  capture(paused: boolean, seeking: boolean): void {
    if (!seeking) this.resume = !paused;
  }

  play(): void {
    this.resume = true;
  }

  pause(): void {
    this.resume = false;
  }

  async apply(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    if (this.resume) {
      if (video.paused) await tryResumePlayback(video, signal);
    } else if (!video.paused) {
      video.pause();
    }
  }
}
