/** Media track category managed by the playback engine. */
export type TrackKind = "audio" | "video";

/** Observable lifecycle state of a TypeType MSE player. */
export type TypeTypeMseState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "seeking"
  | "buffering"
  | "ended"
  | "error"
  | "destroyed";

/** MSE seek strategy used to align playback to seek positions. */
export type PlayerSeekMode = "preroll" | "native";

/** Configuration used to connect an HTML video element to a TypeType SABR session. */
export type TypeTypeMseConfig = {
  endpoint: string;
  videoId: string;
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
  audioOnly?: boolean;
  isLive?: boolean;
  startTimeMs?: number;
  headers?: HeadersInit;
  /** Dynamic header provider evaluated before each HTTP request. */
  getHeaders?: () => HeadersInit | undefined;
  /** Optional 401 handler invoked once per request before retrying with updated headers. */
  onUnauthorized?: (status: number, requestHeaders: Headers) => Promise<boolean | undefined>;
  bufferGoalMs?: number;
  backBufferMs?: number;
  pollIntervalMs?: number;
  manifestRefreshMs?: number;
  manifestPollLimit?: number;
  segmentPollLimit?: number;
  seekMode?: PlayerSeekMode;
};

/** Audio and video format selection applied during a seamless quality switch. */
export type TypeTypeMseQuality = {
  videoItag: number;
  audioItag?: number;
  audioTrackId?: string | null;
};

/** Event emitted while loading, buffering, seeking, or switching playback formats. */
export type TypeTypeMseEvent =
  | { type: "state"; state: TypeTypeMseState }
  | { type: "manifest"; generation: number | null; segmentCount: number }
  | { type: "quality"; videoItag: number; audioItag: number | null }
  | { type: "segment"; kind: TrackKind; url: string; startMs: number; durationMs: number }
  | { type: "buffer"; bufferedEndMs: number; currentTimeMs: number }
  | { type: "seek"; positionMs: number }
  | { type: "error"; error: Error; recoveryPositionMs: number };

/** Discriminant accepted by {@link TypeTypeMsePlayer.on}. */
export type TypeTypeMseEventType = TypeTypeMseEvent["type"];

/** Callback invoked for a subscribed {@link TypeTypeMseEvent}. */
export type TypeTypeMseListener = (event: TypeTypeMseEvent) => void;
