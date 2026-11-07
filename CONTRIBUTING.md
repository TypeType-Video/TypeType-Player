# Contributing to TypeType Player

Thank you for helping improve TypeType playback.

## Scope

This repository owns the browser-side MSE pipeline, TypeType SABR API client, segment scheduling, source-buffer lifecycle, seeks, format switches, recovery, and playback diagnostics.

Open bug reports and feature requests in the [central TypeType issue tracker](https://github.com/TypeType-Video/TypeType/issues). Include the browser, TypeType version, video type, reproduction steps, and relevant player error when reporting playback problems.

Controls and watch-page behavior belong in [TypeType-Frontend](https://github.com/TypeType-Video/TypeType-Frontend). Playback-session generation and segment delivery belong in [TypeType-Server](https://github.com/TypeType-Video/TypeType-Server).

## Set up the project

Use Bun 1.4.4 and Deno 2.9.2.

```sh
git switch dev
bun install --frozen-lockfile
```

The example integration lives under `examples/`. Tests run with `bun:test` and mock the media and network boundaries where browser APIs are not available.

## Programming preferences

- Use Bun exclusively for package commands and keep TypeScript strict.
- Do not use `any`; narrow `unknown` values before use and add explicit return types to exported functions.
- Prefer clear names and structure over explanatory comments, but comments are welcome whenever a contributor finds them useful.
- Name files in kebab-case, types and classes in PascalCase, functions in camelCase, and constants in SCREAMING_SNAKE_CASE.
- Split modules before they become difficult to reason about; do not compress code to keep files short.
- Keep the package independent from any interface framework or player controls.
- Preserve the TypeType HTTP playback-session contract.
- Keep operations abortable and isolate stale requests after seeks or session changes.
- Serialize SourceBuffer mutations and handle teardown during pending work.
- Keep buffer growth bounded.
- Add focused tests for startup, segment continuity, seeks, quality changes, recovery, and destroy behavior.
- Avoid runtime dependencies unless the change has been discussed first.
- Verify that every new development dependency is compatible with the MIT license.
- Update exported types and README examples when the public API changes.

## Required checks

Run the same validation as CI:

```sh
bun audit --audit-level=high
bun run check
bun run check:versions
bun run check:docs
bun run check:jsr
bun run test:coverage
bun run build
node --input-type=module --eval 'const mod = await import("./dist/index.js"); if (typeof mod.TypeTypeMsePlayer !== "function") process.exit(1)'
```

For playback behavior changes, also exercise the affected flow in a browser against a compatible TypeType-Server revision.

## Commits and pull requests

Create your branch from `dev` and open the pull request against `dev`.

Use commit messages in this form:

```text
type: short description
```

Common types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, and `style`. Use the imperative mood and keep the first line under 72 characters.

Describe the playback failure or contract change, affected browsers, regression tests, and any required Server or Frontend update in the pull request.

Contributions to this repository are distributed under the [MIT License](LICENSE).
