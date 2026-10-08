# Third-party components

Mono application code, the Mono mark, and the bundled Mono adaptations of santi.glass and santi.harbor motion are released under the root MIT license by their owner. This license does not change the license of third-party dependencies.

- Open Runde: SIL Open Font License 1.1. The unmodified font files, complete license and pinned upstream commit are in `public/santi-glass/fonts`.
- React, TypeScript, Vite and Tauri JavaScript packages retain their upstream licenses.
- Lucide's underlying icons use ISC; lucide-react package metadata uses MIT.
- Rust dependency names, versions and license expressions are in `DEPENDENCIES.json` and locked by `src-tauri/Cargo.lock`.
- FFmpeg and FFprobe are separate programs. Their binaries are not committed to this source repository. Stage an open-source build locally and preserve its matching licenses, build information and corresponding source when distributing a binary package. Included FFmpeg license texts cover the earlier development build; check the exact build you stage.

Do not interpret the application MIT license as relicensing FFmpeg or other dependencies. The source repository does not contain Microsoft WebView2, the Windows SDK or proprietary font files. These apps currently target Windows and require its platform tools/runtime.
