import { bufferedRangeAt } from "./media-buffer";
import { MediaElementPlaybackError } from "./media-element-observer";

const RECOVERY_DELAY_MS = 500;
const DECODER_RECOVERY_WINDOW_MS = 1_500;
const SEEKED_STABILITY_MS = 100;
const RECOVERY_NUDGE_MS = 100;
const RANGE_END_MARGIN_MS = 100;
const MEDIA_ERR_DECODE = 3;

type SeekMedia = Pick<
  HTMLVideoElement,
  "addEventListener" | "buffered" | "currentTime" | "removeEventListener" | "seeking"
>;

type Scheduler = (callback: () => void, delayMs: number) => () => void;

type PendingSeek = {
  targetMs: number;
  recover: (targetMs: number, freshMediaSource: boolean) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class BufferedSeekRecovery {
  private cancelNudgeTask: (() => void) | null = null;
  private cancelFallbackTimer: (() => void) | null = null;
  private cancelStableTimer: (() => void) | null = null;
  private decoderRecovery: Promise<void> | null = null;
  private media: SeekMedia | null = null;
  private onSeeked: (() => void) | null = null;
  private pending: PendingSeek | null = null;

  constructor(
    private readonly schedule: Scheduler = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  ) {}

  arm(
    media: SeekMedia,
    targetMs: number,
    recovered: () => void,
    recover: PendingSeek["recover"],
  ): Promise<void> {
    this.cancel();
    const completion = new Promise<void>((resolve, reject) => {
      this.pending = {
        targetMs: Math.max(0, Math.round(targetMs)),
        recover,
        resolve,
        reject,
      };
    });
    const onSeeked = () => {
      if (media.seeking) return;
      this.cancelNudgeTimer();
      this.detachSeekListener();
      this.cancelFallbackTimer?.();
      this.cancelFallbackTimer = null;
      this.cancelStableTimer = this.schedule(() => this.completeLocalSeek(), SEEKED_STABILITY_MS);
    };
    this.media = media;
    this.onSeeked = onSeeked;
    media.addEventListener("seeked", onSeeked);
    this.cancelNudgeTask = this.schedule(() => {
      this.cancelNudgeTimer();
      if (nudgeStalledBufferedSeek(media, targetMs)) recovered();
    }, RECOVERY_DELAY_MS);
    this.cancelFallbackTimer = this.schedule(() => {
      this.cancelFallbackTimer = null;
      this.startFallback(false);
    }, DECODER_RECOVERY_WINDOW_MS);
    return completion;
  }

  handleDecoderError(error: Error): boolean {
    if (!(error instanceof MediaElementPlaybackError) || error.code !== MEDIA_ERR_DECODE) {
      return false;
    }
    if (this.decoderRecovery) return true;
    if (!this.pending) return false;
    this.startFallback(true);
    return true;
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    this.clearArmedSeek();
    pending?.reject(new DOMException("Operation aborted", "AbortError"));
  }

  private completeLocalSeek(): void {
    const pending = this.pending;
    this.pending = null;
    this.clearArmedSeek();
    pending?.resolve();
  }

  private startFallback(freshMediaSource: boolean): void {
    const pending = this.pending;
    if (!pending || this.decoderRecovery) return;
    this.pending = null;
    this.clearArmedSeek();
    let task: Promise<void>;
    try {
      task = pending.recover(pending.targetMs, freshMediaSource);
    } catch (recoveryError) {
      pending.reject(recoveryError);
      return;
    }
    this.decoderRecovery = task;
    void task.then(pending.resolve, pending.reject).finally(() => {
      if (this.decoderRecovery === task) this.decoderRecovery = null;
    });
  }

  private clearArmedSeek(): void {
    this.cancelNudgeTimer();
    this.detachSeekListener();
    this.cancelFallbackTimer?.();
    this.cancelFallbackTimer = null;
    this.cancelStableTimer?.();
    this.cancelStableTimer = null;
  }

  private cancelNudgeTimer(): void {
    this.cancelNudgeTask?.();
    this.cancelNudgeTask = null;
  }

  private detachSeekListener(): void {
    if (this.media && this.onSeeked) {
      this.media.removeEventListener("seeked", this.onSeeked);
    }
    this.media = null;
    this.onSeeked = null;
  }
}

export function nudgeStalledBufferedSeek(media: SeekMedia, targetMs: number): boolean {
  if (!media.seeking) return false;
  const safeTargetMs = Math.max(0, Math.round(targetMs));
  const range = bufferedRangeAt(media.buffered, safeTargetMs / 1000);
  if (!range) return false;
  const nudgedMs = Math.min(
    safeTargetMs + RECOVERY_NUDGE_MS,
    Math.floor(range.end * 1000 - RANGE_END_MARGIN_MS),
  );
  if (nudgedMs <= safeTargetMs) return false;
  media.currentTime = nudgedMs / 1000;
  return true;
}
