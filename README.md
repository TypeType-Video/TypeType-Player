U want to know the current position of TypeType about AI ? Go check [this](https://github.com/TypeType-Video/TypeType/blob/dev/AI_TRANSPARENCY.md).

<div align="center">
  <img src="https://raw.githubusercontent.com/TypeType-Video/TypeType/main/assets/banner.svg" alt="TypeType" width="100%">
  <h1>TypeType Player</h1>
  <p>The browser MSE and SABR playback engine for TypeType.</p>
</div>

TypeType-Player is the TypeScript package that turns TypeType playback sessions into audio and video on an `HTMLVideoElement`. It owns the Media Source Extensions pipeline and leaves controls and page layout to the consuming application.

The TypeType web client uses this package through [TypeType-Frontend](https://github.com/TypeType-Video/TypeType-Frontend). The playback-session API is provided by [TypeType-Server](https://github.com/TypeType-Video/TypeType-Server).

## Responsibilities

- Load TypeType SABR manifests and initialization segments
- Select exact video, audio, and audio-track formats
- Schedule and append media segments through MSE
- Coordinate startup, buffering, seeking, quality changes, and audio-only mode
- Bound forward and back buffers
- Recover from stale requests, interrupted fetches, and expired sessions
- Expose playback events and runtime snapshots to the consuming interface

The package contains no user interface and has no runtime dependencies.

## Install

From npm:

```sh
npm install @typetype/mse
```

From JSR:

```sh
bunx jsr add @typetype/mse
```

## Usage

```ts
import { TypeTypeMsePlayer } from "@typetype/mse";

const engine = new TypeTypeMsePlayer(videoElement, {
  endpoint: "/api",
  videoId: "VIDEO_ID",
  videoItag: 137,
  audioItag: 140,
  audioTrackId: null,
  startTimeMs: 0,
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

engine.on("state", (event) => console.log(event.state));
await engine.load();
await engine.play();

await engine.setQuality({ videoItag: 248 });
await engine.setAudioOnly(true);
```

Inspect the current runtime state with:

```ts
const snapshot = engine.snapshot();
```

Always call `destroy()` when the player is no longer used.

## Development

Requirements:

- Bun 1.3.14
- Deno 2.9.2 for JSR and documentation validation

```sh
bun install --frozen-lockfile
bun run check
bun run check:docs
bun run check:jsr
bun run test:coverage
bun run build
```

Releases are published to npm and JSR from version tags through trusted publishing.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Bug reports and feature requests belong in the [central issue tracker](https://github.com/TypeType-Video/TypeType/issues).

## License

TypeType-Player is licensed under the [MIT License](LICENSE).
