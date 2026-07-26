import type { TypeTypeMseState } from "./types";

export class MediaElementPlaybackError extends Error {
  constructor(readonly code: number) {
    super(`Media element failed with code ${code}`);
  }
}

type MediaElementObserverArgs = {
  video: HTMLVideoElement;
  state: (state: TypeTypeMseState) => void;
  error: (error: Error) => boolean;
  progress: (positionMs: number) => void;
};

export class MediaElementObserver {
  constructor(private readonly args: MediaElementObserverArgs) {}

  start(): void {
    this.args.video.addEventListener("playing", this.playing);
    this.args.video.addEventListener("waiting", this.buffering);
    this.args.video.addEventListener("stalled", this.buffering);
    this.args.video.addEventListener("ended", this.ended);
    this.args.video.addEventListener("error", this.error, true);
    this.args.video.addEventListener("timeupdate", this.progress);
  }

  stop(): void {
    this.args.video.removeEventListener("playing", this.playing);
    this.args.video.removeEventListener("waiting", this.buffering);
    this.args.video.removeEventListener("stalled", this.buffering);
    this.args.video.removeEventListener("ended", this.ended);
    this.args.video.removeEventListener("error", this.error, true);
    this.args.video.removeEventListener("timeupdate", this.progress);
  }

  private readonly playing = (): void => this.args.state("playing");

  private readonly buffering = (): void => this.args.state("buffering");

  private readonly ended = (): void => this.args.state("ended");

  private readonly error = (event: Event): void => {
    const code = this.args.video.error?.code ?? 0;
    if (this.args.error(new MediaElementPlaybackError(code))) {
      event.stopImmediatePropagation();
    }
  };

  private readonly progress = (): void => {
    this.args.progress(Math.round(this.args.video.currentTime * 1000));
  };
}
