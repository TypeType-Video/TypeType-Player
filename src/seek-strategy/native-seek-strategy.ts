import type { PlayerSeekMode } from "../types";
import type { SeekAlignmentContext, SeekExecutionContext, SeekStrategy } from "./types";

/** Seek strategy that relies on native browser and GPU frame discard for instant seeking. */
export class NativeSeekStrategy implements SeekStrategy {
  /** The seek mode identifier implemented by this strategy. */
  readonly mode: PlayerSeekMode = "native";

  /** Directly assigns `currentTime` to the requested position without opacity masking or audio muting. */
  alignSessionPosition(ctx: SeekAlignmentContext): void {
    // In native mode, target the exact timestamp directly on the media element.
    // We avoid snapping back to keyframe startMs and avoid setting opacity:0 or muting.
    ctx.video.currentTime = ctx.resolvedStartTimeMs / 1000;
  }

  /** Resolves immediately, allowing hardware decoders to seek without catchup loops. */
  async executeSessionSeek(_ctx: SeekExecutionContext): Promise<number | null> {
    // In native mode, the browser/GPU handles reference frames without presentation.
    // Zero opacity masking, zero 16x catchup loop, zero audio muting.
    // Resumption is cleanly handled by waitForNativeSeek + playbackIntent.apply in switchSession.
    return null;
  }
}
