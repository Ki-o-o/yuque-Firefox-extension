# Build and Reproduction Instructions

This document explains how to reproduce the Firefox extension from source code.

## Overview

This Firefox extension is adapted from the open-source Edge/Chrome extension:
**https://github.com/yuque/yuque-chrome-extension**

The compiled JavaScript files (`app.*.js`, `sandbox.*.js`, etc.) are built from that
repository. Firefox-specific polyfill files and configuration changes were added manually
on top of the compiled output.

---

## Prerequisites

- Node.js 18 or higher
- npm
- Python 3.6 or higher (for the ESM split step)
- Git

---

## Step 1 — Build the original Chrome/Edge extension

```bash
git clone https://github.com/yuque/yuque-chrome-extension.git
cd yuque-chrome-extension
npm install
npm run bundle
```

This produces a `dist/` directory containing the compiled extension files.

Build tools used by the original project:
- **Webpack 5** — module bundler
- **Terser** — JavaScript minifier (via webpack TerserPlugin)
- **TypeScript** — transpiled from `.ts`/`.tsx` source files
- **Babel** — JavaScript transpiler (`@babel/preset-env`, `@babel/preset-react`)
- **Less** — CSS preprocessor (`less-loader`)

---

## Step 2 — Apply Firefox adaptations

Copy the following files from this source package into the `dist/` directory,
replacing any existing files of the same name:

| File | Description |
|------|-------------|
| `firefox-polyfill.js` | Background page API compatibility layer |
| `firefox-sidebar-polyfill.js` | Sidebar/iframe API compatibility layer |
| `firefox-content-polyfill.js` | Content script API compatibility layer |
| `manifest.json` | Firefox-specific manifest (replaces Chrome manifest) |
| `tabs/sandbox.html` | Modified HTML with Firefox polyfill script tags |

```bash
cp firefox-polyfill.js           dist/
cp firefox-sidebar-polyfill.js   dist/
cp firefox-content-polyfill.js   dist/
cp manifest.json                 dist/
cp tabs/sandbox.html             dist/tabs/
```

---

## Step 3 — Split the large ESM bundle

Firefox AMO enforces a 5MB per-file parse limit. The file `esm-19.*.js` produced
by the build exceeds this limit (~7.3MB) and must be split into two parts.

Run the provided split script from inside the `dist/` directory:

```bash
cd dist/
python ../split-esm.py esm-19.66294edf.js 3.7
```

> **Note:** The hash in the filename (`66294edf`) may differ if you build from a
> different commit. Adjust the filename accordingly.

This script will:
1. Back up the original `esm-19.*.js` as `esm-19.*.js.bak`
2. Write `esm-19.part1.*.js` (~3.7 MB) — first half of modules
3. Overwrite `esm-19.*.js` (~3.5 MB) — second half of modules

The `tabs/sandbox.html` file (already copied in Step 2) contains the required
`<script src="/esm-19.part1.*.js">` tag that preloads part1 before part2
is loaded dynamically by the Parcel runtime.

---

## Step 4 — Package as .xpi

Run the packaging script from the `dist/` directory:

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File pack.ps1
```

Or package manually — create a ZIP archive of all files inside `dist/`
(not the `dist/` folder itself) and rename the extension from `.zip` to `.xpi`.

Ensure `manifest.json` is at the **root** of the archive, not inside a subdirectory.

---

## Firefox-specific changes summary

The following changes were made to adapt the Chrome/Edge extension for Firefox:

### New files added

| File | Purpose |
|------|---------|
| `firefox-polyfill.js` | Maps `chrome.*` APIs to Firefox equivalents; provides stubs for unsupported APIs (`chrome.offscreen`, `chrome.sidePanel`); proxies `tabs.*` calls from sidebar context to background |
| `firefox-sidebar-polyfill.js` | Fixes `chrome.runtime.sendMessage` async behavior in Firefox; provides `tabs.*` shim that routes through background page |
| `firefox-content-polyfill.js` | Fixes content script API issues; injects CSS into Shadow DOM to correct floating ball hover area |

### Modified files

| File | Change |
|------|--------|
| `manifest.json` | Changed `service_worker` to `background.scripts`; added `sidebar_action`; added `browser_specific_settings.gecko`; removed `offscreen` permission and `externally_connectable` |
| `tabs/sandbox.html` | Added `overflow:hidden` CSS to prevent double scrollbar; added preload `<script>` tag for `esm-19.part1.*.js` |

### Deleted files

| File | Reason |
|------|--------|
| `firefox-background.js` | Superseded by the more complete `firefox-polyfill.js` |

---

## Source file inventory

Files submitted as source (Firefox adaptation layer):

```
firefox-polyfill.js            (~61 KB)  Background API polyfill
firefox-sidebar-polyfill.js    (~15 KB)  Sidebar API polyfill
firefox-content-polyfill.js    (~9 KB)   Content script polyfill
manifest.json                  (~4 KB)   Firefox manifest
tabs/sandbox.html              (~2 KB)   Modified sandbox page
split-esm.py                   (~4 KB)   ESM bundle split utility
README-BUILD.md                          This file
```

All Firefox polyfill files are human-readable, unminified JavaScript.
No additional build tools are required for the Firefox-specific files.
