import type { BufferPolicy } from "./buffer-policy";
import type { MediaSourceController } from "./media-source-controller";
import type { PlaybackResponse } from "./playback-client";
import { rateAwareBufferGoalMs } from "./playback-rate";
import type { PlaybackWindowRequest } from "./playback-window";

type Args = {
  response: Pick<PlaybackResponse, "generation">;
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
  audioOnly: boolean;
  playbackRate?: (() => number) | undefined;
  policy: BufferPolicy;
  media: Pick<MediaSourceController, "bufferedRanges">;
};

export function createPlaybackWindowRequest(
  args: Args,
  playerTimeMs: number,
): PlaybackWindowRequest {
  const playbackRate = args.playbackRate?.() ?? 1;
  return {
    generation: args.response.generation,
    playerTimeMs,
    videoItag: args.videoItag,
    audioItag: args.audioItag,
    audioTrackId: args.audioTrackId,
    audioOnly: args.audioOnly,
    playbackRate,
    bufferGoalMs: rateAwareBufferGoalMs(args.policy.bufferGoalMs, playbackRate),
    backBufferMs: args.policy.backBufferMs,
    bufferedRanges: args.media.bufferedRanges().map((range) => ({
      itag: range.kind === "audio" ? args.audioItag : args.videoItag,
      startMs: range.startMs,
      endMs: range.endMs,
    })),
  };
}
