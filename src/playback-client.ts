import { type HttpClient, TypeTypeHttpError } from "./http-client";
import type { LivePlaybackWindow } from "./manifest";
import {
  type PlaybackWindow,
  type PlaybackWindowRequest,
  parseLivePlaybackWindow,
  parsePlaybackWindow,
} from "./playback-window";
import {
  isPlaybackSessionExpiryStatus,
  playbackSessionExpiredError,
} from "./playback-window-error";

export type PlaybackResponse = {
  sessionId: string;
  videoId: string;
  videoItag?: number;
  audioItag?: number;
  audioTrackId?: string | null;
  generation: number | null;
  ready: boolean;
  retryAfterMs: number | null;
  startTimeMs?: number | null;
  live?: LivePlaybackWindow | null;
};

export type CreatePlaybackRequest = {
  videoId: string;
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
  startTimeMs: number;
  audioOnly: boolean;
  isLive?: boolean;
};

export type SeekPlaybackOptions = {
  videoItag?: number;
  audioItag?: number;
  audioTrackId?: string | null;
  audioOnly?: boolean | undefined;
};

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function stringField(value: object, key: string): string | null {
  const result = field(value, key);
  return typeof result === "string" && result.length > 0 ? result : null;
}

function numberField(value: object, key: string): number | null {
  const result = field(value, key);
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

function parsePlaybackResponse(value: unknown): PlaybackResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid playback response");
  const sessionId = stringField(value, "sessionId");
  const videoId = stringField(value, "videoId");
  if (!sessionId || !videoId) throw new Error("Invalid playback response");
  const videoItag = numberField(value, "videoItag");
  const audioItag = numberField(value, "audioItag");
  const hasAudioTrackId = "audioTrackId" in value;
  return {
    sessionId,
    videoId,
    ...(videoItag === null ? {} : { videoItag }),
    ...(audioItag === null ? {} : { audioItag }),
    ...(hasAudioTrackId ? { audioTrackId: stringField(value, "audioTrackId") } : {}),
    generation: numberField(value, "generation"),
    ready: field(value, "ready") === true,
    retryAfterMs: numberField(value, "retryAfterMs"),
    startTimeMs: numberField(value, "startTimeMs"),
    live: parseLivePlaybackWindow(field(value, "live")),
  };
}

export class PlaybackClient {
  constructor(private readonly http: HttpClient) {}

  async create(request: CreatePlaybackRequest, signal?: AbortSignal): Promise<PlaybackResponse> {
    const params = new URLSearchParams({
      videoItag: String(request.videoItag),
      audioItag: String(request.audioItag),
      startTimeMs: String(request.startTimeMs),
    });
    if (request.audioTrackId) params.set("audioTrackId", request.audioTrackId);
    if (request.audioOnly) params.set("audioOnly", "true");
    if (request.isLive) params.set("isLive", "true");
    const videoId = encodeURIComponent(request.videoId);
    const init = signal ? { method: "POST", signal } : { method: "POST" };
    const response = await this.http.json(`/sabr/playback/${videoId}?${params}`, init);
    return parsePlaybackResponse(response);
  }

  async seek(
    sessionId: string,
    positionMs: number,
    options: SeekPlaybackOptions = {},
    signal?: AbortSignal,
  ): Promise<PlaybackResponse> {
    const session = encodeURIComponent(sessionId);
    const params = new URLSearchParams({
      playerTimeMs: String(Math.max(0, Math.round(positionMs))),
    });
    if (options.videoItag) params.set("videoItag", String(options.videoItag));
    if (options.audioItag) params.set("audioItag", String(options.audioItag));
    if (options.audioTrackId) params.set("audioTrackId", options.audioTrackId);
    if (options.audioOnly) params.set("audioOnly", "true");
    const init = signal ? { method: "POST", signal } : { method: "POST" };
    const response = await this.http.json(`/sabr/playback/${session}/seek?${params}`, init);
    return parsePlaybackResponse(response);
  }

  async position(
    sessionId: string,
    request: PlaybackWindowRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackWindow> {
    return this.postWindow(sessionId, "position", request, signal);
  }

  async prefetch(
    sessionId: string,
    request: PlaybackWindowRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackWindow> {
    return this.postWindow(sessionId, "prefetch", request, signal);
  }

  async segments(
    sessionId: string,
    request: PlaybackWindowRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackWindow> {
    return this.postWindow(sessionId, "segments", request, signal);
  }

  async window(
    sessionId: string,
    request: PlaybackWindowRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackWindow> {
    return this.postWindow(sessionId, "window", request, signal);
  }

  private async postWindow(
    sessionId: string,
    action: "position" | "prefetch" | "segments" | "window",
    request: PlaybackWindowRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackWindow> {
    const path = `/sabr/playback/${encodeURIComponent(sessionId)}/${action}`;
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    } satisfies RequestInit;
    try {
      const response = await this.http.json(path, signal ? { ...init, signal } : init);
      return parsePlaybackWindow(response, this.http.absolute(path));
    } catch (error) {
      if (error instanceof TypeTypeHttpError && isPlaybackSessionExpiryStatus(error.status)) {
        throw playbackSessionExpiredError();
      }
      throw error;
    }
  }
}
