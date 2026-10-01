# PS Neighborhood package converter

This helper converts supported PS5 finalized debug base-game packages into verified
ShadowMount FFPFSC images. It does not add native PS5 fPKG support to etaHEN/kstuff.
Separate patch/DLC packages and retail packages are not converted.

## Credits and reproducible source

- PS5PKGTool by pearlxcore, GPL-3.0, pinned v1.2.0 commit
  `0072cb40584a2a4a7d6cf3a1b73e11617fa04e74`:
  https://github.com/pearlxcore/PS5PKGTool
  The Core, Ffpfsc and Ufs2 sources are retained in `vendor/` with their notices.
  Neighborhood changes: extraction-only Core project (no GUI, texture encoders,
  proprietary backends or their package dependencies), bounded parallel PFSC
  compression (8 workers, 128 blocks per batch), stricter extraction paths and
  extraction-space preflight.
- ProsperoPkgTool clean-room managed engine, MIT, copyright 2026 pearlxcore.
  The original license and version accompany the vendored engine. The engine is
  supplied upstream as a managed binary; we do not claim its source is included.
- UFS2Tool by SvenGDK, BSD-2-Clause; original license retained in the Ufs2 folder.
- ooz by Powzix, GPL-3.0-or-later, portable adaptation by q3k (pyooz), pinned
  `fde8c264d0bbcee36d9836cb1895c02861783d4e`:
  https://github.com/q3k/pyooz
  Neighborhood supplies a decompression-only ABI adapter with padded private
  buffers. `oo2core_9_win64.dll` is the compatibility filename of our **open-source
  ooz build**, not Epic/RAD's proprietary DLL. Do not replace it in distribution.
- The .NET runtime is redistributed with its MIT license and third-party notices.
- Format work credited upstream: MkPFS (PSBrew/Renan Barreto), ps5-exfat-builder
  (kerrdec97), and PS5 Dump and Image Converter (strongt1me).

Build with .NET 10 SDK and Zig 0.14.1, on Windows x64:

```
node scripts/build-pkg-converter.mjs
```

Set `PSN_DOTNET` / `PSN_ZIG` to compiler executables if they are not at the default
locations. The published helper includes .NET runtime; end users need no SDK.
The complete converter directory, including vendor sources and licenses, belongs
in source distributions. Do not include temporary extracted game files or PKGs.

Conversion reads the PKG, restores CNT metadata into sce_sys, builds exFAT/PFSC,
decodes every image block, compares decoded SHA-256 with an independent exFAT
stream of the extracted files, and hashes the finished container. The original
package is held read-only. Only verified images can enter automatic transfer.
