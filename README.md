# PeerSync Web (static site)

A browser version that **talks to PeerSync** (Android / Windows / iOS).
It runs on static hosting such as GitHub Pages alone (no server-side code).

Published at: https://jpgjm.github.io/PeerSync-Web/

## Features
| Feature | Status | Notes |
|---|---|---|
| Device ID (iroh public key): created, saved, QR code, Share / Copy | ✅ | The key is in localStorage (fixed per browser). Tapping the ID copies it. Share where the browser has a share sheet, otherwise Copy |
| Pairing by QR code or manual entry | ✅ | `peersync:<ID>?name=<name>`, same as the apps. A scan fills in "Add device" |
| Pairing request (browser -> device) | ✅ | Sent when you add a device; the device is listed under "Pending" and saved only when the other device allows it. Sent again automatically when the device answers "not paired" |
| Pairing request (device -> browser) | ✅ | "Pair with this device?" with Allow / Cancel; cancelled automatically after 120 seconds |
| Unpair (both ways) | ✅ | The other device removes this one too. If it's offline, it is told the next time it connects ("unpaired") |
| Online status of paired devices | ✅ | PING every 30 s while Device Hub is shown and the tab is visible: Online · Relay N ms / Online · hasn't added this device / Offline. Devices with a running transfer count as online and aren't pinged |
| Device name | ✅ | Settings > Device name. Default: the browser and OS (e.g. "Chrome (Android)", "Safari (iPad)"). Paired devices pick up a new name with the next PING (both ways) |
| Restart | ✅ | This device > Restart: stops the node and starts a new one with the same ID (like the app). Disabled while starting or stopping |
| Send text (browser -> device) | ✅ | Multiple lines. Waits up to 125 s for the other device to accept |
| Send files and folders (browser -> device) | ✅ | Several files; folders keep their structure (`<folder>/<relative path>`, empty folders aren't sent). Sending the same again resumes where it stopped. Folders only where the browser supports picking them |
| Receive text (device -> browser) | ✅ | Dialog with the text; Copy / Close |
| Receive files (device or browser -> browser) | ✅ | "Files from …" with the list; Accept / Decline (declined automatically after 120 seconds). Each file is saved as a browser download |
| Paste / Clear in every text field | ✅ | One button at the end of the field: Paste while empty, Clear once something is typed. "The clipboard is empty." shows under the field |
| History (Transfers / Pairing) | ✅ | Top bar of Device Hub. Not saved (gone when the page closes) |
| Logs | ✅ | Settings > Logs. Copy / Clear |
| Reset device ID | ✅ | Settings > Relay. Every paired device is told first, then the key changes (offline devices keep the old ID in their list) |
| Your own relay (URL) | ✅ | Settings > Relay |
| Direct connections (hole punching) | ❌ | **Not possible in a browser.** Always through a relay (below) |
| Shared folder (browse / fetch) | — | Removed (like the app 0.2.36) |

## Differences from the apps (important)
A browser can't send arbitrary UDP packets, so iroh can't punch holes and **always goes through a relay server**
(official: https://docs.iroh.computer/deployment/wasm-browser-support).
- Speed and latency depend on the relay. For large transfers every day, use the app or your own relay
- End-to-end encryption is unchanged (the relay can't read the data)
- The route always says "Relay"

### Safari (iPhone / iPad / Mac) and the trailing dot in relay URLs
iroh's default relays and the discovery service give host names with a trailing dot
(`https://use1-1.relay.n0.iroh.link./`). The public relays drop connections whose SNI has the trailing dot,
and Safari (WebKit) sends it as is, so it would stay "Not connected to the relay".
The browser version uses the URLs without the dot, both for its own relay and for other devices' relays
found through discovery (`strip_trailing_dot` / `StripRelayDots` in `wasm/peersync-wasm/src/lib.rs`). It is the
same server, so it still talks to the apps, which keep the dot.

## How to use
1. Open the page; a device ID is created (fixed per browser)
2. Show the QR code (This device > Show QR code) and scan it with the other device's app, or add the other device
   with "+" (Add by QR code / Enter manually). The other device gets a pairing request; allow it there
   (when the other device adds this one, "Pair with this device?" appears here; press Allow)
3. To send, press Send on the device's row -> Files / Folder / Text. The other device asks to accept
   (unless it has "Accept without asking" on). Files go to its save folder (e.g. Android: Download/PeerSync/<this device's name>/…)
4. When another device sends files, "Files from …" appears. Check the list and press Accept

## Saving received files
Files arrive one by one and are saved one by one (not zipped, so not everything is held in memory).
Each file is written to temporary storage and then handed to the browser as a download. The temporary storage is
OPFS (disk space inside the browser); only browsers that can't write there keep the file in memory. The download
is named after the file only (folders aren't kept). If the connection drops, the file starts over.
Leftovers in temporary storage are removed the next time the page opens.
While receiving, History > Transfers shows the progress. Cancel stops receiving and tells the sender
"Cancelled by the receiver."

## Layout
```
wasm/peersync-wasm/   Minimal Rust shim around iroh 1.x with wasm-bindgen
                      (the WASM counterpart of the apps' native/peersync-iroh C ABI)
web/
  src/proto/          Wire / FileServer / RemoteClient — TS ports of the apps' protocol code
                      (depend on neither iroh nor the browser; tested with in-memory pipes)
  src/core/           settings (localStorage) / browserKind (default device name) / node (connections, Restart) /
                      presence (online status) / sinks (receiving to downloads) / qr / pairing /
                      peerServices (incoming offers, pairing, unpairing, PING) / outgoing (sending, requests)
  src/ui/             Material Web loading (md.ts), dialogs (dialogs.ts), icons (icons.ts), Paste / Clear (pasteClear.ts)
  src/main.ts         UI (no framework; Material Web components)
.github/workflows/    On push: WASM -> Vite build -> Pages deploy
```

## Screens
The screens follow the app (Compose Material 3), with Material Web 2.5.0 components:
- **Device Hub** (default): This device (status line and Restart, the device ID chip that copies on tap, Show QR code,
  Share or Copy), Paired devices ("name, ID, online status | divider | Send, Unpair"), Pending.
  "+" at the bottom right opens Add by QR code / Enter manually. The top bar's history icon opens History
- **Settings**: Device name, Relay (URL with the app's three change icons, Reset device ID), Logs
- **History** (Transfers | Pairing tabs, Clear all) and **Logs** (Copy, Clear) are detail screens without the
  navigation bar; the browser's Back returns to the tab
- Not identical to the app: Material Web has no M3 Expressive components (the FAB menu's motion, shape morphing),
  and the "Accept without asking", "Always listen", "Keep screen on" and "Save to" settings don't exist here
- Material Web is in maintenance mode (almost no new features or fixes until a new maintainer is found); pinned to 2.5.0
- The snackbar isn't in Material Web, so it is built to the M3 spec (inverse surface, above the FAB and navigation bar)
- Colors: the scheme made from the seed `#6750A4` (M3 baseline purple) with material-color-utilities' SchemeTonalSpot,
  at the top of `web/src/style.css` (light / dark)
- **Nothing is loaded from other servers**: icons are SVG paths of Material Symbols (Apache-2.0) in
  `web/src/ui/icons.ts`, and the device's fonts are used (no Google Fonts; no outside code or styles on the origin
  that holds the secret key)
- File and folder pickers open synchronously inside the item's click (opening them from a closed menu's event isn't
  treated as a user action and Safari etc. don't show them; same as FilePizza). Copying received text also happens
  inside the Copy click
- No `confirm()` / `alert()`; md-dialog in `web/src/ui/dialogs.ts` instead (if "Don't show dialogs" is pressed in Safari,
  `confirm()` silently returns false from then on)
- Dialogs that shouldn't close on a scrim tap (typed input, pairing requests, file offers) close with Esc only (`keepOpenOnScrim`)

## Protocol compatibility
- ALPN `peersync/0`, big-endian, str = u16 length + UTF-8, blob = i32 length + raw bytes, 256 KiB chunks,
  offset resume — same as the apps (`web/src/proto/wire.ts`)
- Ops: OFFER_STATUS(4) / PUT(5, both ways) / OFFER2(6) / PAIR(7) / PAIR_STATUS(8) / UNPAIR(9) / PING(10).
  LIST(1) / GET(2) (shared folder) and 3 (old OFFER) are answered with "unknown op" (**for apps 0.2.36 and later**;
  older apps can still pair and send, but their browse screen gets an error, and they show this browser as online
  because "unknown op" counts as an answer)
- iroh core **1.x** (pinned in Cargo.lock). Works with Android 1.2.0 / Windows and iOS 1.4.x
- Connections from unpaired devices are accepted; everything except PAIR / PAIR_STATUS / UNPAIR gets ERR `not paired`
  (same as the apps since 0.2.14; the other device then requests pairing automatically)

## Development
```bash
# WASM (needs Rust + wasm32-unknown-unknown + wasm-bindgen-cli 0.2.130)
cd wasm/peersync-wasm
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ../../web/src/wasm \
  target/wasm32-unknown-unknown/release/peersync_wasm.wasm

# Web
cd web
npm install
npm test        # protocol tests over in-memory pipes, presence, default device name (78 tests)
npm run dev     # dev server
npm run build   # static site in dist/
```

## Deploy (first time only)
1. Push this repository to `jpgjm/PeerSync-Web` (main branch)
2. GitHub -> Settings -> Pages -> **set Source to "GitHub Actions"**
3. From then on, every push to main deploys

## Known limits
- Closing the tab or the device sleeping stops sending (closing asks first). Sending again resumes
- Right after the other device restarts, the first request waits up to about 30 s until the old connection is found dead,
  then connects again and retries
- History isn't saved; it is gone when the page closes
- Settings from versions before this one: the shared folder and save folder choices stay unused in the browser's
  storage (they aren't migrated or removed). A device name that was never changed (the old Japanese default) now shows the new default
