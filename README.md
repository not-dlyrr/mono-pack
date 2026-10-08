# Mono Pack

Public application source: https://github.com/not-dlyrr/mono-pack

Application code is MIT licensed. Bundled Open Runde fonts are OFL-1.1 licensed. See `THIRD_PARTY_NOTICES.md` and `DEPENDENCIES.json` for dependencies. This checkout includes the current liquid-glass UI and the restrained 160–180 ms motion update.

## Fresh checkout

This source repository excludes compiled executables, recordings, machine-specific QA artifacts, node_modules and proprietary Apple fonts. Install dependencies with `npm ci`. FFmpeg/FFprobe must be staged before media tests or a functional Windows installer build.

Use `scripts/stage-ffmpeg.ps1 -Directory <FFmpeg-bin-folder> -LicenseDirectory <license-folder>` to stage ffmpeg.exe, ffprobe.exe, shared DLLs and license files into `src-tauri/resources`. The earlier tested build is BtbN's win64 LGPL shared FFmpeg build. Preserve its upstream source/build information. Image and rename functionality are implemented in the Rust engine.


Windows desktop utility built with Tauri 2, Rust, React, TypeScript, and Vite. Image work uses native Rust decoders/encoders. Media processing uses a bundled LGPL shared FFmpeg build. No account, upload, analytics, remote processing, or local HTTP processing server.

The desktop interface uses santi.glass in dark mode, bundled Open Runde fonts, and short, restrained motion. The custom titlebar supports dragging, double-click maximize, minimize, maximize/restore and close. Checkboxes, the format dropdown and the Liquid Glass switch are app-owned controls with keyboard support. Liquid Glass in the sidebar persists its choice and switches both the in-app lens and native Mica/Acrylic material; reduced motion and reduced transparency are respected.

## Build

Prerequisites: Windows x64, Node.js 20.19+ or 22.12+, Rust MSVC toolchain, Visual Studio C++ build tools with Windows SDK, and WebView2. Keep `src-tauri/resources` with the supplied FFmpeg binaries and shared DLLs.

```powershell
cd <path-to-mono-pack>
npm ci
npm run tauri -- dev
npm run build
npm run test:engine
npm run package
```

`npm run package` builds the frontend, native release executable, and per-user NSIS installer in `src-tauri/target/release/bundle/nsis`. `Cargo.lock` and `package-lock.json` lock the dependency graph. `.cargo/config.toml` limits compilation to two jobs for machines with 16 GB RAM. Icons are generated from `mono-mark.svg` with `npx tauri icon mono-mark.svg -o src-tauri/icons`.

## Workflow

1. Add files with the picker (Ctrl+O) or native drag-and-drop.
2. Choose Images, Video, Audio, or Rename and adjust settings. Select an output folder.
3. Preview results. Review invalid inputs and collision suffixes. Input/output changes require a refreshed preview.
4. Run batch (Ctrl+Enter after preview). The native queue processes one file at a time. New jobs can be added while another runs. Cancel skips remaining files and stops the active media process. Open output folder from the results.

Images: PNG, JPEG, WebP in either direction. Aspect ratio is preserved within the requested width/height. 0 means original dimension. PNG compression is lossless; JPEG/WebP quality is 1–100. Image metadata is removed on re-encoding; EXIF orientation is applied first. JPEG composites transparency over white. Only the first image frame is processed.

Video: MP4 (MPEG-4 Part 2 / AAC) or WebM (VP9 / Opus). Includes the first video stream and optional first audio stream. Audio extraction: first audio stream to MP3, WAV/PCM, or M4A/AAC. Missing streams and corrupt media produce per-file errors. Removing metadata also removes chapters. Compression does not guarantee a smaller file than the original.

Rename: case-sensitive find/replace on the filename stem; then prefix, numbering, suffix, and unchanged extension. Copy mode is the default. In-place mode uses a verified copy, durable journal, and source removal after successful publication. Undo verifies output hashes, never overwrites a different file occupying the original name, and preserves edited outputs. Original timestamps and ACLs are not reproduced by copy-based renaming. Export undo record saves a JSON record; this release has no standalone record-import tool.

## Safety and persistence

- Windows publication uses `MoveFileExW` without replacement and with write-through. Existing output names receive `(2)`, `(3)`, etc. A new collision after preview fails that file rather than overwriting it.
- Unicode absolute paths are passed as native arguments, never through a shell.
- Each output is written to a UUID temporary file in the destination directory. Successful publication renames it atomically; cancelled and failed jobs remove tracked temporary files.
- Jobs and presets are saved in `%APPDATA%\com.mono.pack\history.json`. Per-file transitions append to a synced incremental journal; queue boundaries compact it into a synced snapshot using replacement. A sequence number makes replay safe if compaction is interrupted. Retain this file and rename outputs for undo. Clear finished history retains undoable rename jobs.
- Restart marks queued/running/undoing jobs interrupted and cleans tracked temporary files. Completed outputs remain. Interrupted verified rename outputs retain undo information. Jobs never resume automatically; add unfinished files again.
- FFmpeg children are attached to a Windows Job Object with kill-on-close. Unexpected application termination closes the handle and terminates the child.
- A single-instance plugin prevents simultaneous writers to history. A corrupt/unwritable history blocks new jobs instead of overwriting records silently.

## Distribution

FFmpeg binaries are staged locally and are not stored in Git. Preserve the exact FFmpeg build's licenses and corresponding source/build information for any binary distribution. The current desktop package uses replaceable LGPL shared libraries. The application source license does not change those licenses. See `THIRD_PARTY_NOTICES.md` and [FFmpeg distribution guidance](https://ffmpeg.org/legal.html).

The Windows shell requires WebView2. Tauri's installer can bootstrap it if absent. Installers are unsigned and have no automatic updater.

## Limits

- Windows x64 only; no macOS/Linux package.
- Up to 10,000 files per job and 200 history entries; clear finished history to make room.
- Native processing is sequential to bound CPU/memory; media encoders use two threads. The UI lists are virtualized.
- Image decoding is bounded to 16,384 pixels per side and 512 MiB. Color profiles, animation, and image metadata are not preserved. WebP compression is lossy in this version.
- Image cancellation takes effect between decode/resize/encode stages; an individual native codec call is not immediately interruptible. FFmpeg and FFprobe cancellation is checked about every 80 ms. Media probing has a 30-second timeout. Rename hashing and copying check cancellation between buffer reads.
- Long path behavior still depends on Windows and codec support. Network/removable folders and disk-full failures are reported but not exhaustively tested.
- Renaming is copy-based, including in-place mode; it needs temporary free space approximately equal to the source file size. Undo depends on unmodified outputs and durable history; backup software should retain both.
- No full screen-reader audit or fresh Windows VM validation is claimed. Runtime capabilities and limits should be checked on the target Windows machine.
