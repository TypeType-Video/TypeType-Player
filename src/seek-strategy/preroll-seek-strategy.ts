import { decodeStartMs, runDecodePreroll } from "../decode-preroll";
import { tryResumePlayback } from "../media-playback";
import type { PlayerSeekMode } from "../types";
import type { SeekAlignmentContext, SeekExecutionContext, SeekStrategy } from "./types";

/** Seek strategy that snaps to the preceding keyframe, masks opacity, and runs a decode catchup loop. */
export class PrerollSeekStrategy implements SeekStrategy {
  /** The seek mode identifier implemented by this strategy. */
  readonly mode: PlayerSeekMode = "preroll";

  /** Snaps `currentTime` to the keyframe start boundary and holds opacity and audio for preroll. */
  alignSessionPosition(ctx: SeekAlignmentContext): void {
    const startMs = decodeStartMs(ctx.manifest, ctx.resolvedStartTimeMs);
    const decodesToTarget =
      ctx.resolvedStartTimeMs > startMs && (ctx.finalizePausedSeek || ctx.shouldResume);
    if (decodesToTarget) {
      ctx.transientMediaState.holdForPreroll();
    }
    ctx.video.currentTime = startMs / 1000;
  }

  /** Executes accelerated decode preroll until the playhead catches up to the seek target. */
  async executeSessionSeek(ctx: SeekExecutionContext): Promise<number | null> {
    const startMs = decodeStartMs(ctx.manifest, ctx.resolvedStartTimeMs);
    if (ctx.resolvedStartTimeMs > startMs) {
      if (ctx.shouldResume) {
        await this.runPreroll(ctx, true, false);
        return null;
      }
      if (ctx.finalizePausedSeek) {
        await this.runPreroll(ctx, false, true);
        return null;
      }
      return ctx.resolvedStartTimeMs;
    }
    if (ctx.shouldResume) {
      if (ctx.resolvedStartTimeMs > 0) {
        await this.runPreroll(ctx, Boolean(ctx.handoff), true);
      }
      await tryResumePlayback(ctx.video);
      return null;
    }
    if (ctx.finalizePausedSeek && ctx.resolvedStartTimeMs > 0) {
      await this.runPreroll(ctx, false, true);
      return null;
    }
    return null;
  }

  /** Fills the buffer and runs accelerated decode catchup to the target position. */
  private async runPreroll(
    ctx: SeekExecutionContext,
    resumePlayback: boolean,
    requireFrame: boolean,
  ): Promise<void> {
    await ctx.fillBuffer();
    return runDecodePreroll(
      ctx.video,
      ctx.resolvedStartTimeMs,
      resumePlayback,
      ctx.signal,
      requireFrame,
      ctx.transientMediaState,
    );
  }
}
