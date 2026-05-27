# Building Production Installers

Quick start, then the things that go wrong if you skip the boring sections.

## Commands

```bash
npm install              # one-time
npm run build            # build for the host platform — default sensible choice
npm run build:win        # Windows NSIS installer (.exe)
npm run build:mac        # macOS DMG (arm64 + x64 separately)
npm run build:all        # both — Mac requires running on a Mac for signing
npm run clean            # wipe dist/ and out/ without building
```

All artifacts land in `dist/`. The build script prints sizes and paths when done.

The build pipeline runs:

1. **Clean** — wipes `dist/` and `out/` so no stale files leak in.
2. **Typecheck** — `tsc --noEmit` on both the node (main+preload) and web (renderer) projects. Catches type errors before we spend a minute packaging. Use `--skip-typecheck` if you must.
3. **Bundle** — `electron-vite build` produces `out/main`, `out/preload`, `out/renderer`.
4. **Package** — `electron-builder` produces the platform installer in `dist/`.

## Cross-platform rules

| Build target | Host OS | What you get |
|---|---|---|
| Windows | Windows | Signed if cert configured, else unsigned + SmartScreen warning |
| Windows | Mac / Linux | Unsigned EXE, SmartScreen warning on first run |
| Mac | Mac (with Developer ID cert) | Properly signed and notarizable DMG |
| Mac | Windows / Linux | Unsigned DMG; Gatekeeper blocks; users right-click → Open to bypass |

The build script warns when you cross-compile into the "unsigned" cases above.

## Why `koffi` needs special handling

`koffi` is the FFI library we use to call Win32's `SetWindowDisplayAffinity` for the WDA_EXCLUDEFROMCAPTURE privacy mode. It loads its native `.node` binaries via `require()` at runtime. When everything is packed into `app.asar`, Node can't open a `.node` file from inside an archive — the OS loader needs a real on-disk path.

[electron-builder.yml](../electron-builder.yml) has:

```yaml
asarUnpack:
  - "**/node_modules/koffi/**"
```

…which extracts koffi to `app.asar.unpacked/node_modules/koffi/` in the packaged build. If you ever see logs in production like `FFI load FAILED: ...` and the window is capturable, this is the first thing to check.

## Code signing

Currently unconfigured. For production releases, set environment variables before running the build:

### Windows (Authenticode)

```bash
# Path to a .pfx certificate file + password
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=...
npm run build:win
```

Or use an Azure Trusted Signing / cloud signer through electron-builder's `win.sign` hook.

### Mac (Developer ID + notarization)

```bash
# Apple Developer ID Application certificate must be installed in Keychain.
# electron-builder picks it up automatically by name.
# For notarization (required for Gatekeeper-clean DMGs):
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # from appleid.apple.com
export APPLE_TEAM_ID="ABCD123456"
npm run build:mac
```

`electron-builder` runs `notarytool` post-package; expect a 2-5 minute wait for Apple to respond.

## What ends up in `dist/`

After `npm run build:all` on a Mac you should see roughly:

```
dist/
├── Interview Copilot-0.1.0-setup.exe        ~85 MB  (Windows installer)
├── Interview Copilot-0.1.0-portable.exe     ~85 MB  (Windows portable, single-file)
├── Interview Copilot-0.1.0-arm64.dmg        ~95 MB  (Apple Silicon)
├── Interview Copilot-0.1.0-x64.dmg          ~95 MB  (Intel Mac)
├── win-unpacked/                                    (Windows app directory)
├── mac-arm64/                                       (Mac arm64 app bundle)
└── mac/                                             (Mac x64 app bundle)
```

Distribute the `.exe` and `.dmg` files. The unpacked directories are kept for debugging — they contain the exact files the installer would lay down, which is useful for verifying `app.asar.unpacked/node_modules/koffi/build/...` exists.

### Installer vs Portable on Windows

The Windows build produces two `.exe` files:

| File | What it does |
|---|---|
| `Interview Copilot-0.1.0-setup.exe` | NSIS installer. User picks an install directory, gets a Start menu shortcut and Add/Remove Programs entry. Normal Windows install. |
| `Interview Copilot-0.1.0-portable.exe` | Single-file portable. Double-click to launch — no install step, no admin prompt, no registry entries, no shortcut. The app extracts to `%TEMP%\<hash>\` on each launch and runs from there. Useful for USB sticks, shared corporate machines without admin, or quick try-it-and-delete scenarios. |

**Important for both:** user data (`settings.json`, `app.log`, login session) lives in `%APPDATA%\interview-copilot\` regardless of installation mode. So a user can install the NSIS version, save their JD and resume, uninstall, then run the portable .exe and their setup persists. That also means uninstall does NOT wipe user data — to fully remove the app, delete the `%APPDATA%\interview-copilot` folder manually after uninstalling.

## Versioning

The version comes from `package.json`'s `version` field. Bump it before tagging a release:

```bash
npm version patch    # 0.1.0 → 0.1.1
npm version minor    # 0.1.0 → 0.2.0
npm version major    # 0.1.0 → 1.0.0
```

`npm version` also creates a git tag, which is handy for matching the installer to a commit later.

## Things that go wrong

| Symptom | Cause | Fix |
|---|---|---|
| FFI load FAILED in production | `koffi` got packed into asar | Confirm `asarUnpack` line is in `electron-builder.yml` |
| Window appears in screenshots after install | Either FFI failed (above) OR you're on Win10 < 2004 | Check log; if old Win10, expected (fallback is WDA_MONITOR — window shows as black instead of invisible) |
| Mac DMG opens but app immediately quits | Translocation / Gatekeeper | Right-click → Open the first time, or sign + notarize |
| "vite v5.x.x building SSR bundle…" then nothing | Port 5173 stale from a previous dev session | `Get-Process node \| Stop-Process` (Win) / `pkill node` (Mac), retry |
| Build hangs at "publishing" | electron-builder trying to publish to GitHub | We don't publish from this config; if you added a `publish:` block, remove or set `--publish never` |

## App icons

A 1024×1024 placeholder PNG ships at `resources/icon.png` — generated by [`scripts/make-icon.mjs`](../scripts/make-icon.mjs) (pure Node, no graphics deps). `electron-builder` auto-detects it and produces `.ico` (Windows) and `.icns` (Mac) variants at package time, so a single PNG is enough.

To regenerate the placeholder (e.g. after tweaking the colours in the script):

```bash
npm run make-icon
```

For a real release, replace `resources/icon.png` with a branded 1024×1024 PNG (or drop in `.ico` / `.icns` files alongside; electron-builder prefers them over the PNG if present). Recommended formats:

- `resources/icon.ico` — Windows multi-resolution (16/24/32/48/64/128/256)
- `resources/icon.icns` — macOS (use `iconutil` from a 1024×1024 `iconset` on Mac)
- `resources/icon.png` — fallback used for both if the above aren't present

`electron-builder` looks under `resources/` because `directories.buildResources` in [electron-builder.yml](../electron-builder.yml) points there.
