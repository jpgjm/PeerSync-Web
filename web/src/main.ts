/**
 * PeerSync Web — entry point and UI.
 * The screens follow the app (shared/ui/HomeScreen.kt, HistoryScreen.kt, LogScreen.kt):
 *   Device Hub (This device, Paired devices, Pending) | Settings (Device name, Relay, Logs),
 *   History (Transfers | Pairing) and Logs as detail screens.
 */
import "./style.css";
import init from "./wasm/peersync_wasm";
import wasmUrl from "./wasm/peersync_wasm_bg.wasm?url";

import { Settings, shortId, Peer } from "./core/settings";
import { encodePairing, decodePairing } from "./core/pairing";
import { qrToCanvas, startQrScan, QrScanner } from "./core/qr";
import { clearTempFiles, DownloadFileSink, tempStorageKind } from "./core/sinks";
import { FileServer } from "./proto/fileServer";
import { RemoteClient } from "./proto/remoteClient";
import { ERR_NOT_PAIRED, ERR_UNPAIRED, OfferItem, RemoteError } from "./proto/wire";
import { NodeStatus, PeerSyncNode } from "./core/node";
import {
  BrowserPeerServices,
  CONSENT_TIMEOUT_MS,
  IncomingFiles,
  IncomingText,
  PairingLogKind,
  PairRequest,
  ReceiveProgress,
} from "./core/peerServices";
import { CancelledError, Decision, notifyUnpair, requestPair, SendFile, sendFiles } from "./core/outgoing";
import { INTERVAL_MS, PeerPresence, Presence } from "./core/presence";
import { confirmDialog, noticeDialog } from "./ui/dialogs";
import { icon, IconName } from "./ui/icons";
import { fillIcons, keepOpenOnScrim, openDialog, setIcon } from "./ui/md";
import { attachPasteClear } from "./ui/pasteClear";
import type { MdDialog } from "@material/web/dialog/dialog.js";
import type { MdOutlinedTextField } from "@material/web/textfield/outlined-text-field.js";
import type { MdMenu } from "@material/web/menu/menu.js";
import type { MdLinearProgress } from "@material/web/progress/linear-progress.js";
import type { MdTextButton } from "@material/web/button/text-button.js";
import type { MdIconButton } from "@material/web/iconbutton/icon-button.js";
import type { MdTabs } from "@material/web/tabs/tabs.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Screen = "hub" | "settings" | "history" | "logs";
/** The screen shown (Device Hub and Settings are tabs; History and Logs are detail screens). */
let screen: Screen = "hub";
/** The tab to return to from a detail screen. */
let tabScreen: "hub" | "settings" = "hub";

// ---------------- log ----------------

const logEl = $("log");
const logLines: string[] = [];
/** Kept lines (older ones are dropped). */
const LOG_MAX = 1000;

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `${t} ${msg}`;
  console.log(`[PeerSync] ${msg}`);
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.shift();
  if (screen === "logs") renderLog();
}

function renderLog() {
  logEl.textContent = logLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------------- startup ----------------

await init({ module_or_path: wasmUrl });
fillIcons();

const settings = new Settings();
log(`PeerSync Web started: ${navigator.userAgent}`);
log(`device name: ${settings.deviceName}${settings.customName ? "" : " (default)"}`);

const services = new BrowserPeerServices(
  settings,
  {
    onText: (t) => showIncomingText(t),
    onFileOffer: (o) => showFileOffer(o),
    onFileOfferResolved: (token) => closeFileOffer(token),
    openSink: (o, item) => openIncomingSink(o, item),
    onReceiveProgress: (o, p) => onReceiveProgress(o, p),
    onReceiveDone: (o, p) => onReceiveDone(o, p),
    onReceiveFailed: (o, relPath, reason) => onReceiveFailed(o, relPath, reason),
    onPairRequest: (r) => showPairRequest(r),
    onPairResolved: (token) => closePairRequest(token),
    onUnpaired: (id, name) => showUnpairedNotice(id, name),
    onPeersChanged: () => renderPeers(),
    onPing: (id) => presence.heardFrom(id),
    onPairingLog: (kind, id, name, detail) => addPairingLog(kind, id, name, detail),
  },
  log,
);
const server = new FileServer(log, services);
const node = new PeerSyncNode(settings, server, log);

function client(peerId: string): RemoteClient {
  return new RemoteClient(
    () => node.openStream(peerId),
    () => node.dropConnection(peerId),
  );
}

const presence = new Presence({
  settings,
  client,
  dropConnection: (id, why) => node.dropConnection(id, why),
  transferring: (id) => transfers.some((t) => t.state === "run" && t.peerId.toLowerCase() === id.toLowerCase()),
  pathSummary: (id) => node.pathSummary(id),
  onUnpaired: (peer) => removedByPeer(peer, "reply"),
  onChange: () => renderPeers(),
  log,
});

// ---------------- keyboard detection (focus rings only for keyboard use) ----------------

const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape"]);
document.addEventListener("keydown", (e) => {
  if (NAV_KEYS.has(e.key)) document.documentElement.dataset.keyboard = "";
}, true);
document.addEventListener("pointerdown", () => {
  delete document.documentElement.dataset.keyboard;
}, true);

// ---------------- snackbar ----------------

const snackbar = $("snackbar");
const snackbarText = $("snackbar-text");
const snackbarAction = $("snackbar-action");
let snackbarTimer: number | undefined;
let snackbarOnAction: (() => void) | null = null;
/** Current duration (ms). 0 = until × is pressed. Paused while the mouse is over it. */
let snackbarMs = 0;

/** short = SnackbarDuration.Short (4 s), long = Long (10 s), like the app. */
const SNACK_MS = { short: 4_000, long: 10_000 } as const;

function startSnackTimer() {
  clearTimeout(snackbarTimer);
  if (snackbarMs > 0) snackbarTimer = window.setTimeout(() => (snackbar.hidden = true), snackbarMs);
}

/** Short message at the bottom. duration: short / long / indefinite (until × is pressed). */
function snack(
  text: string,
  opts: { duration?: "short" | "long" | "indefinite"; action?: string; onAction?: () => void } = {},
) {
  clearTimeout(snackbarTimer);
  snackbarText.textContent = text;
  snackbarOnAction = opts.onAction ?? null;
  snackbarAction.hidden = !opts.action;
  snackbarAction.textContent = opts.action ?? "";
  // hide first so showing the same element again still animates
  snackbar.hidden = true;
  void snackbar.offsetWidth;
  snackbar.hidden = false;
  const d = opts.duration ?? (opts.action ? "long" : "short");
  snackbarMs = d === "indefinite" ? 0 : SNACK_MS[d];
  startSnackTimer();
}
snackbar.addEventListener("pointerenter", (e) => {
  if (e.pointerType === "mouse") clearTimeout(snackbarTimer);
});
snackbar.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "mouse") startSnackTimer();
});
snackbarAction.addEventListener("click", () => {
  snackbar.hidden = true;
  snackbarOnAction?.();
});
$("snackbar-close").addEventListener("click", () => {
  clearTimeout(snackbarTimer);
  snackbar.hidden = true;
});

/** Copies text and confirms with a snackbar. Call inside a click (Safari needs a user action). */
async function copyText(text: string, done = "Copied.") {
  try {
    await navigator.clipboard.writeText(text);
    snack(done);
  } catch (e) {
    log(`copy failed: ${errMsg(e)}`);
    snack("Couldn't copy (the browser didn't allow it).");
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "<name> (ID: <first 10 chars>…)" (the app's PsText.peerWithId). */
function peerWithId(name: string, id: string): string {
  return `${name} (ID: ${shortId(id)}…)`;
}

/** Changes text only when it differs (doesn't disturb a selection or screen readers). */
function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------------- This device: status and Restart ----------------

const statusEl = $("status");
const restartBtn = $<MdIconButton>("restart");

function statusText(s: NodeStatus): string {
  switch (s.state) {
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting…";
    case "online":
      return `Online (relay: ${s.detail ?? "-"})`;
    case "offline":
      return s.detail ?? "Not connected to the relay";
    case "error":
      return `Error: ${s.detail ?? "?"}`;
  }
}

function renderStatus() {
  const s = node.status;
  setText(statusEl, statusText(s));
  statusEl.dataset.state = s.state;
  // like the app 0.2.37: disabled while the node is starting or stopping (repeated taps)
  restartBtn.disabled = node.busy || s.state === "starting";
  renderRelay();
}

node.onStatus = (s) => {
  renderStatus();
  // check devices right away when the node comes online (instead of up to 30 s later)
  if (s.state === "online") restartPresence();
};
node.onBusy = () => renderStatus();

restartBtn.addEventListener("click", () => {
  log("restart button");
  void node.restart();
});

// ---------------- This device: ID, QR code, Share / Copy ----------------

function renderIdentity() {
  $("my-id-text").textContent = settings.nodeId;
}
renderIdentity();

$("my-id").addEventListener("click", () => {
  log("copy device ID");
  void copyText(settings.nodeId);
});

const qrDialog = $<MdDialog>("qr-dialog");
$("show-qr").addEventListener("click", async () => {
  await qrToCanvas($<HTMLCanvasElement>("my-qr"), encodePairing(settings.nodeId, settings.deviceName));
  openDialog(qrDialog);
});

// Share where the browser has a share sheet (Android / iOS / Windows), otherwise Copy (like the app's desktop)
const canShare = typeof navigator.share === "function";
$("share-code").hidden = !canShare;
$("copy-code").hidden = canShare;
$("share-code").addEventListener("click", async () => {
  const code = encodePairing(settings.nodeId, settings.deviceName);
  try {
    await navigator.share({ text: code });
    log("share sheet: done");
  } catch (e) {
    // AbortError = the user closed the sheet
    log(`share sheet: ${errMsg(e)}`);
  }
});
$("copy-code").addEventListener("click", () => {
  log("copy device ID (button)");
  void copyText(settings.nodeId);
});

// ---------------- Paired devices ----------------

const peerList = $("peer-list");
const peerRows = new Map<string, HTMLLIElement>();

function presenceLine(p: PeerPresence): { text: string; tone: string } {
  switch (p.kind) {
    case "checking":
      return { text: "Checking…", tone: "checking" };
    case "online":
      return { text: p.route ? `Online · ${p.route}` : "Online", tone: "online" };
    case "notPairedThere":
      return { text: "Online · hasn't added this device", tone: "not-paired" };
    case "offline":
      return { text: "Offline", tone: "offline" };
  }
}

function peerRow(p: Peer): HTMLLIElement {
  const key = p.id.toLowerCase();
  let li = peerRows.get(key);
  if (li) return li;
  li = document.createElement("li");
  li.className = "card peer-card";
  // like the app 0.2.36: "name, ID, online status | vertical divider | Send, Unpair"; the left side does nothing
  li.innerHTML = `
    <div class="grow">
      <div class="name"></div>
      <div class="sub mono"></div>
      <div class="presence"><span class="dot" aria-hidden="true"></span><span class="presence-text"></span></div>
    </div>
    <span class="v-divider" aria-hidden="true"></span>
    <md-icon-button data-act="send" title="Send">${icon("send")}</md-icon-button>
    <md-icon-button data-act="unpair" title="Unpair">${icon("linkOff")}</md-icon-button>`;
  li.addEventListener("click", (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const peer = settings.peers.find((x) => x.id.toLowerCase() === key);
    if (!peer) return;
    if (act === "unpair") void confirmUnpair(peer);
    else if (act === "send") openSendMenu(peer);
  });
  peerRows.set(key, li);
  return li;
}

function renderPeers() {
  const peers = settings.peers;
  $("peer-empty").hidden = peers.length > 0;
  const keep = new Set(peers.map((p) => p.id.toLowerCase()));
  for (const [key, li] of peerRows) {
    if (!keep.has(key)) {
      li.remove();
      peerRows.delete(key);
    }
  }
  let before: Element | null = peerList.firstElementChild;
  for (const p of peers) {
    const li = peerRow(p);
    if (li !== before) peerList.insertBefore(li, before);
    before = li.nextElementSibling;
    setText(li.querySelector(".name")!, p.name);
    setText(li.querySelector(".sub")!, `${shortId(p.id)}…`);
    const line = presenceLine(presence.get(p.id));
    setText(li.querySelector(".presence-text")!, line.text);
    li.querySelector<HTMLElement>(".presence")!.dataset.tone = line.tone;
    li.querySelector('[data-act="send"]')!.setAttribute("aria-label", `Send to ${p.name}`);
    li.querySelector('[data-act="unpair"]')!.setAttribute("aria-label", `Unpair ${p.name}`);
  }
  renderPending();
}

// ---------------- Pending (requests this browser sent that weren't approved yet) ----------------

/** Devices we asked to pair with that aren't paired yet (the app's Pairing.outgoing). */
let outgoing: Peer[] = [];

function renderPending() {
  const list = outgoing.filter((o) => !settings.isPaired(o.id));
  $("pending-title").hidden = list.length === 0;
  const ul = $("pending-list");
  ul.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      li.className = "card peer-card pending";
      li.innerHTML = `
        <div class="grow">
          <div class="name"></div>
          <div class="sub mono"></div>
          <div class="sub">Waiting for approval…</div>
        </div>
        <md-circular-progress indeterminate aria-label="Waiting for approval"></md-circular-progress>`;
      li.querySelector(".name")!.textContent = p.name;
      li.querySelector(".mono")!.textContent = `${shortId(p.id)}…`;
      return li;
    }),
  );
}

// ---------------- Pairing history ----------------

interface PairingLogEntry {
  id: number;
  kind: PairingLogKind;
  peerId: string;
  peerName: string;
  detail?: string;
  at: number;
}

/** Newest first. Not saved (gone when the page closes). */
const pairingLog: PairingLogEntry[] = [];
let pairingSeq = 0;

const PAIRING_LABELS: Record<PairingLogKind, [string, IconName]> = {
  requestSent: ["Pairing requested", "callMade"],
  sentAccepted: ["Request allowed", "checkCircle"],
  sentRejected: ["Request declined", "cancel"],
  sentFailed: ["Couldn't send request", "error"],
  requestReceived: ["Pairing request received", "callReceived"],
  receivedAccepted: ["You allowed the request", "checkCircle"],
  receivedRejected: ["You cancelled the request", "cancel"],
  receivedTimedOut: ["No response (cancelled automatically)", "hourglassEmpty"],
  unpairedByMe: ["You unpaired", "linkOff"],
  unpairedByPeer: ["Other device unpaired", "linkOff"],
};

function addPairingLog(kind: PairingLogKind, peerId: string, peerName: string, detail?: string): number {
  const id = ++pairingSeq;
  pairingLog.unshift({ id, kind, peerId, peerName, detail, at: Date.now() });
  renderHistory();
  return id;
}

function updatePairingDetail(id: number, detail: string) {
  const e = pairingLog.find((x) => x.id === id);
  if (e) e.detail = detail;
  renderHistory();
}

// ---------------- Pairing requests (this browser -> other device) ----------------

/** Requests in flight per device (lower-case ID). A second request for the same device waits for the first. */
const inFlight = new Map<string, Promise<Decision | "failed">>();

/**
 * Requests pairing (the app's Pairing.requestTo). The device is saved only when it allows the request
 * (like the app 0.2.22); while waiting, a new device is listed under "Pending".
 */
function requestTo(peer: Peer): Promise<Decision | "failed"> {
  const key = peer.id.toLowerCase();
  const running = inFlight.get(key);
  if (running) {
    log(`pair request to ${peer.name} already in flight`);
    return running;
  }
  const newPeer = !settings.isPaired(peer.id);
  if (newPeer) {
    outgoing = [...outgoing.filter((o) => o.id.toLowerCase() !== key), peer];
    renderPending();
  }
  const p = (async (): Promise<Decision | "failed"> => {
    log(`pair request -> ${peer.name} (${shortId(peer.id)}) as "${settings.deviceName}"`);
    addPairingLog("requestSent", peer.id, peer.name);
    try {
      const d = await requestPair(client(peer.id), settings.deviceName);
      log(`pair request -> ${peer.name}: ${d}`);
      if (d === "accepted") {
        if (!settings.isPaired(peer.id)) settings.addPeer(peer.id, peer.name);
        settings.clearUnpaired(peer.id);
        addPairingLog("sentAccepted", peer.id, peer.name);
        snack(`Paired with ${peer.name}.`);
        restartPresence();
      } else if (d === "rejected") {
        addPairingLog("sentRejected", peer.id, peer.name);
        // kept until × or "Request again" is pressed so it isn't missed (like the app 0.2.15)
        snack(`${peer.name} declined pairing.`, {
          duration: "indefinite",
          action: "Request again",
          onAction: () => void requestTo(peer),
        });
      } else {
        addPairingLog("sentFailed", peer.id, peer.name, "No response from the other device.");
        snack(`${peer.name} didn't respond to the pairing request.`, {
          action: "Request again",
          onAction: () => void requestTo(peer),
        });
      }
      return d;
    } catch (e) {
      const reason = errMsg(e);
      log(`pair request -> ${peer.name} failed: ${reason}`);
      addPairingLog("sentFailed", peer.id, peer.name, reason);
      snack(`Couldn't send a pairing request to ${peer.name}: ${reason}`, {
        action: "Request again",
        onAction: () => void requestTo(peer),
      });
      return "failed";
    } finally {
      inFlight.delete(key);
      outgoing = outgoing.filter((o) => o.id.toLowerCase() !== key);
      renderPeers();
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * Handles errors from a device that are about pairing. Returns true if handled.
 * - not paired: the device hasn't added this browser -> request pairing
 * - unpaired: the device removed this browser (its notice didn't arrive) -> remove it here too
 */
function handlePeerError(peer: Peer, e: unknown): boolean {
  if (!(e instanceof RemoteError)) return false;
  if (e.message === ERR_NOT_PAIRED) {
    void requestTo(peer);
    return true;
  }
  if (e.message === ERR_UNPAIRED) {
    removedByPeer(peer, "reply");
    return true;
  }
  return false;
}

/** Unpaired by the other device: removed here without asking and a notice is shown (like the app 0.2.22). */
function removedByPeer(peer: Peer, how: string) {
  if (!settings.isPaired(peer.id)) return;
  const name = settings.peerName(peer.id);
  log(`unpaired by ${name} (${shortId(peer.id)}): removing automatically (${how})`);
  settings.removePeer(peer.id);
  addPairingLog("unpairedByPeer", peer.id, name, `Also removed from this device (${how}).`);
  node.dropConnection(peer.id, "unpaired");
  renderPeers();
  showUnpairedNotice(peer.id, name);
}

function showUnpairedNotice(id: string, name: string) {
  void noticeDialog({
    title: "Device unpaired",
    body: `${peerWithId(name, id)} unpaired from this device. It has been removed here too.`,
  });
}

// ---------------- Unpair (this browser) ----------------

async function confirmUnpair(peer: Peer) {
  const ok = await confirmDialog({
    title: "Unpair this device?",
    body:
      `${peerWithId(peer.name, peer.id)} will be unpaired. This device is also removed from the other device ` +
      "automatically (if it's offline, the next time it connects to this device).",
    confirmLabel: "Unpair",
    tone: "critical",
  });
  if (!ok) return;
  log(`unpair confirmed by user: ${peer.name} (${shortId(peer.id)})`);
  // remove here first and remember it in case the notice doesn't arrive (the device then gets "unpaired")
  settings.removePeer(peer.id);
  settings.markUnpaired(peer.id);
  renderPeers();
  const logId = addPairingLog("unpairedByMe", peer.id, peer.name, "Notifying the other device…");
  let detail: string;
  try {
    await notifyUnpair(client(peer.id), settings.deviceName);
    settings.clearUnpaired(peer.id);
    log(`unpair -> ${peer.name}: delivered`);
    detail = "Also removed on the other device.";
  } catch (e) {
    if (e instanceof RemoteError) {
      log(`unpair -> ${peer.name}: remote error ${e.message}`);
      detail = `Couldn't notify the other device: ${e.message}`;
    } else {
      log(`unpair -> ${peer.name}: not delivered (${errMsg(e)})`);
      detail = "Didn't reach the other device. It will be removed there the next time it connects.";
    }
  } finally {
    node.dropConnection(peer.id, "unpaired");
  }
  updatePairingDetail(logId, detail);
}

// ---------------- Reset device ID ----------------

const resetBtn = $<MdIconButton>("reset-id");
const resetProgress = $("reset-progress");
let resetting = false;

resetBtn.addEventListener("click", async () => {
  const peers = settings.peers;
  const ok = await confirmDialog({
    title: "Reset device ID?",
    body:
      "This device gets a new ID. " +
      (peers.length > 0
        ? `All ${plural(peers.length, "paired device")} ${peers.length === 1 ? "is" : "are"} unpaired and this device is removed from them too. `
        : "") +
      "Devices that are offline now keep the old ID in their list, and transfers in progress stop. " +
      "To use them again, add this device again.",
    confirmLabel: "Reset",
    tone: "critical",
  });
  if (!ok || resetting) return;
  resetting = true;
  resetBtn.hidden = true;
  resetProgress.hidden = false;
  log(`reset device ID: notifying ${peers.length} paired devices`);
  try {
    // with the old key still in use, tell every paired device at once
    const results = await Promise.all(
      peers.map(async (p) => {
        let detail: string | null = null;
        try {
          await notifyUnpair(client(p.id), settings.deviceName);
          log(`reset: unpair -> ${p.name}: delivered`);
        } catch (e) {
          log(`reset: unpair -> ${p.name}: not delivered (${errMsg(e)})`);
          detail =
            e instanceof RemoteError
              ? `Couldn't notify the other device: ${e.message}`
              : "Didn't reach the other device. It keeps the old ID in its list.";
        }
        addPairingLog("unpairedByMe", p.id, p.name, "Device ID reset. " + (detail ?? "Also removed on the other device."));
        return detail === null;
      }),
    );
    settings.resetIdentity();
    outgoing = [];
    renderIdentity();
    renderPeers();
    await node.restartNow();
    const failed = results.filter((x) => !x).length;
    log(`reset device ID done: ${results.length - failed} notified, ${failed} not reached; new ID ${settings.nodeId}`);
    snack(
      failed === 0
        ? "Device ID reset."
        : `Device ID reset. ${plural(failed, "device")} couldn't be told (they keep the old ID in their list).`,
    );
  } catch (e) {
    log(`reset device ID failed: ${errMsg(e)}`);
  } finally {
    resetting = false;
    resetBtn.hidden = false;
    resetProgress.hidden = true;
  }
});

// ---------------- Pairing requests (other device -> this browser) ----------------

const pairDialog = $<MdDialog>("pair-dialog");
keepOpenOnScrim(pairDialog); // the other device is waiting, so a scrim tap doesn't close it
const pairQueue: PairRequest[] = [];
let pairShowing: PairRequest | null = null;

function showPairRequest(r: PairRequest) {
  pairQueue.push(r);
  if (!pairShowing) nextPairRequest();
}
function nextPairRequest() {
  const r = pairQueue.shift();
  pairShowing = r ?? null;
  if (!r) return;
  $("pair-body").textContent =
    `${peerWithId(r.name, r.peerId)} wants to pair with this device. ` +
    'If you allow it, it\'s added to "Paired devices" and you can send files and text to each other.';
  openDialog(pairDialog);
}
/** Closes a request that was settled elsewhere (timed out). */
function closePairRequest(token: string) {
  const i = pairQueue.findIndex((x) => x.token === token);
  if (i >= 0) pairQueue.splice(i, 1);
  if (pairShowing?.token === token && pairDialog.open) void pairDialog.close("resolved");
}
pairDialog.addEventListener("closed", () => {
  const r = pairShowing;
  if (r && pairDialog.returnValue !== "resolved") {
    const allow = pairDialog.returnValue === "allow";
    services.decide(r.token, allow);
    if (allow) {
      snack(`Paired with ${r.name}.`);
      restartPresence();
    }
  }
  pairShowing = null;
  nextPairRequest();
});

// ---------------- Add device (FAB menu -> QR code / Enter manually) ----------------

const addMenu = $<MdMenu>("add-menu");
const addFabIcon = $("add-fab-icon");
$("add-fab").addEventListener("click", () => {
  addMenu.open = !addMenu.open;
});
// like the app's ToggleFloatingActionButton: + while closed, × while open
addMenu.addEventListener("opening", () => setIcon(addFabIcon, "close"));
addMenu.addEventListener("closing", () => setIcon(addFabIcon, "add"));

const addDialog = $<MdDialog>("add-dialog");
keepOpenOnScrim(addDialog); // don't lose typed input to a scrim tap
const addId = $<MdOutlinedTextField>("add-id");
const addName = $<MdOutlinedTextField>("add-name");
const addOk = $<MdTextButton>("add-ok");
/** Name that came with the pairing code (used when the name field is left empty). */
let addCodeName: string | null = null;

function validateAdd(): { id: string; name: string | null } | null {
  const raw = addId.value;
  const parsed = decodePairing(raw);
  let error: string | null = null;
  if (raw.trim() && !parsed) error = "Invalid device ID format";
  else if (parsed && parsed.id.toLowerCase() === settings.nodeId.toLowerCase()) error = "This is this device's own ID";
  addIdTools.setError(error);
  addOk.disabled = !parsed || error !== null;
  return error === null ? parsed : null;
}
const addIdTools = attachPasteClear(addId, log, () => {
  const parsed = validateAdd();
  // a pasted pairing code brings the name along (like a scanned one)
  if (parsed?.name && !addName.value) {
    addName.value = parsed.name;
    addNameTools.refresh();
  }
});
const addNameTools = attachPasteClear(addName, log);

function openAddDialog(rawId: string, name: string | null) {
  addId.value = rawId;
  addName.value = name ?? "";
  addCodeName = name;
  addIdTools.refresh();
  addNameTools.refresh();
  validateAdd();
  openDialog(addDialog);
}

addDialog.addEventListener("closed", () => {
  if (addDialog.returnValue !== "ok") return;
  const parsed = validateAdd();
  if (!parsed) return;
  const name = addName.value.trim() || parsed.name || addCodeName || shortId(parsed.id);
  const peer: Peer = { id: parsed.id, name };
  if (settings.isPaired(peer.id)) {
    settings.addPeer(peer.id, peer.name); // already paired: just rename
    renderPeers();
  } else {
    log(`add peer -> pair request only: ${peer.name} (${shortId(peer.id)})`);
    snack("Pairing request sent. Waiting for the other device to approve.");
  }
  void requestTo(peer);
});

$("add-manual").addEventListener("click", () => {
  log("fab menu: manual input");
  openAddDialog("", null);
});

let scanner: QrScanner | null = null;
const scanDialog = $<MdDialog>("scan-dialog");
function stopScan() {
  scanner?.stop();
  scanner = null;
}
$("add-qr").addEventListener("click", async () => {
  log("fab menu: scan qr");
  openDialog(scanDialog);
  try {
    scanner = await startQrScan(
      $<HTMLVideoElement>("scan-video"),
      (text) => {
        scanner = null;
        void scanDialog.close("found");
        log("qr scanned");
        // like the app: the scan fills in the "Add device" dialog
        const decoded = decodePairing(text);
        openAddDialog(decoded ? text.trim() : text, decoded?.name ?? null);
      },
      (msg) => {
        scanner = null;
        void scanDialog.close("error");
        void noticeDialog({ title: "Couldn't read the QR code", body: msg });
      },
    );
    // the dialog may have been closed while the camera permission was asked; stop here then
    if (!scanDialog.open) stopScan();
  } catch (e) {
    void scanDialog.close("error");
    void noticeDialog({
      title: "Can't use the camera",
      body: `${errMsg(e)}\nAllow the camera for this page in the browser settings, or use "Enter manually".`,
    });
  }
});
$("scan-stop").addEventListener("click", () => void scanDialog.close("stop"));
// stop the camera however the dialog closes (Cancel, Esc, scrim)
scanDialog.addEventListener("close", stopScan);

// ---------------- Settings: one-line input dialog (device name, relay URL) ----------------

const inputDialog = $<MdDialog>("input-dialog");
keepOpenOnScrim(inputDialog);
const inputText = $<MdOutlinedTextField>("input-text");
const inputTools = attachPasteClear(inputText, log);
let inputDone: ((value: string) => void) | null = null;

function openInputDialog(o: { title: string; value: string; placeholder?: string; type?: string }, onOk: (v: string) => void) {
  $("input-title").textContent = o.title;
  inputText.type = (o.type ?? "text") as MdOutlinedTextField["type"];
  inputText.placeholder = o.placeholder ?? "";
  inputText.value = o.value;
  inputTools.refresh("");
  inputDone = onOk;
  openDialog(inputDialog);
  inputDialog.addEventListener("opened", () => inputText.focus(), { once: true });
}
inputDialog.addEventListener("closed", () => {
  const done = inputDone;
  inputDone = null;
  if (inputDialog.returnValue === "ok" && done) done(inputText.value);
});

// ---------------- Settings: device name ----------------

function renderName() {
  $("name-desc").textContent = `Other devices see this name. Default: ${settings.defaultDeviceName}`;
  setText($("name-value"), settings.deviceName);
}
renderName();

$("edit-name").addEventListener("click", () => {
  log("edit device name");
  openInputDialog(
    {
      title: `Device name (leave empty for "${settings.defaultDeviceName}")`,
      value: settings.customName,
      placeholder: settings.defaultDeviceName,
    },
    (v) => {
      settings.setDeviceName(v);
      log(`device name -> ${settings.deviceName}${settings.customName ? "" : " (default)"}`);
      renderName();
      // paired devices pick up the new name with the next presence check (PING carries it)
      restartPresence();
    },
  );
});

// ---------------- Settings: relay ----------------

/** Normalizes relay URLs for comparison (trailing / and ., case). */
function normalizeRelay(s: string): string {
  return s.trim().replace(/[/.]+$/, "").toLowerCase();
}

function renderRelay() {
  const relay = settings.relayUrl;
  setText($("relay-value"), relay || "iroh public relay (default)");
  const s = node.status;
  const usable = relay !== "" && s.state === "online" && normalizeRelay(s.detail ?? "") === normalizeRelay(relay);
  // same three icons as the app: not set / set and connected / set but not connected
  setIcon($("relay-icon"), relay === "" ? "changeCircle" : usable ? "publishedWithChanges" : "syncProblem");
}
renderRelay();

$("edit-relay").addEventListener("click", () => {
  log("edit relay");
  openInputDialog(
    {
      title: "Your own relay URL (leave empty for the public relay)",
      value: settings.relayUrl,
      placeholder: "e.g. https://relay.example.com",
      type: "url",
    },
    (v) => {
      settings.relayUrl = v;
      log(`relay -> ${settings.relayUrl || "(public)"}; restarting the node`);
      renderRelay();
      void node.restartNow();
    },
  );
});

// ---------------- Transfers (History > Transfers) ----------------

type TransferKind = "send" | "receive";

interface Transfer {
  id: number;
  kind: TransferKind;
  /** File name, "N items" or "Text (N characters)". */
  fileName: string;
  peerId: string;
  peerName: string;
  done: number;
  total: number;
  state: "run" | "ok" | "err" | "cancel";
  error?: string;
  /** Waiting before any progress (indeterminate bar). */
  waiting: boolean;
  startedAt: number;
  abort: AbortController;
}

/** Newest first. Not saved (gone when the page closes). */
const transfers: Transfer[] = [];
let transferSeq = 0;
const transferList = $("transfer-list");
/** One row element per transfer, reused (rebuilding on every update would swap the Cancel button under the pointer). */
const transferRows = new Map<Transfer, HTMLLIElement>();

function newTransfer(kind: TransferKind, fileName: string, peerId: string, peerName: string, total: number): Transfer {
  const t: Transfer = {
    id: ++transferSeq,
    kind,
    fileName,
    peerId,
    peerName,
    done: 0,
    total,
    state: "run",
    waiting: true,
    startedAt: Date.now(),
    abort: new AbortController(),
  };
  transfers.unshift(t);
  renderHistory();
  return t;
}

function transferRow(t: Transfer): HTMLLIElement {
  let li = transferRows.get(t);
  if (li) return li;
  li = document.createElement("li");
  li.className = "card history-card";
  li.innerHTML = `
    <div class="row">
      <div class="name grow"></div>
      <md-text-button class="cancel">Cancel</md-text-button>
    </div>
    <md-linear-progress value="0"></md-linear-progress>
    <div class="sub state"></div>
    <div class="time"></div>`;
  li.querySelector(".cancel")!.addEventListener("click", () => {
    log(`cancel #${t.id}`);
    t.abort.abort();
  });
  transferRows.set(t, li);
  return li;
}

function transferStateText(t: Transfer): string {
  const verb = t.kind === "send" ? "Send" : "Receive";
  // received files are browser downloads, so there is no resume on this side
  const hint = t.kind === "send" ? " (send again to resume where it stopped)" : "";
  switch (t.state) {
    case "run":
      return t.waiting
        ? `${t.kind === "send" ? "Waiting for approval…" : "Connecting…"} · ${t.peerName}`
        : `${verb} · ${fmtSize(t.done)} / ${fmtSize(t.total)} · ${t.peerName}`;
    case "ok":
      return `${t.kind === "send" ? "Sent" : "Received"} · ${t.peerName}`;
    case "err":
      return `${verb} failed: ${t.error ?? "?"}${hint}`;
    case "cancel":
      return `${verb} cancelled${hint}`;
  }
}

function renderTransfers() {
  $("transfer-empty").hidden = transfers.length > 0 || historyTab !== 0;
  for (const [t, li] of transferRows) {
    if (!transfers.includes(t)) {
      li.remove();
      transferRows.delete(t);
    }
  }
  let before: Element | null = transferList.firstElementChild;
  for (const t of transfers) {
    const li = transferRow(t);
    if (li !== before) transferList.insertBefore(li, before);
    before = li.nextElementSibling;
    setText(li.querySelector(".name")!, t.fileName);
    li.querySelector<HTMLElement>(".cancel")!.hidden = t.state !== "run";
    const bar = li.querySelector<MdLinearProgress>("md-linear-progress")!;
    bar.hidden = t.state !== "run";
    bar.indeterminate = t.waiting;
    const p = t.total > 0 ? t.done / t.total : 0;
    if (!t.waiting && bar.value !== p) bar.value = p;
    const state = li.querySelector<HTMLElement>(".state")!;
    setText(state, transferStateText(t));
    state.classList.toggle("error", t.state === "err");
    setText(li.querySelector(".time")!, fmtTime(t.startedAt));
  }
}

const pairingList = $("pairing-list");

function renderPairingLog() {
  $("pairing-empty").hidden = pairingLog.length > 0 || historyTab !== 1;
  pairingList.replaceChildren(
    ...pairingLog.map((e) => {
      const [label, ic] = PAIRING_LABELS[e.kind];
      const li = document.createElement("li");
      li.className = "card history-card pairing";
      if (e.kind === "sentFailed") li.classList.add("is-error");
      li.innerHTML = `${icon(ic)}<div class="grow"><div class="name"></div><div class="sub"></div><div class="sub detail"></div><div class="time"></div></div>`;
      li.querySelector(".name")!.textContent = label;
      li.querySelector(".sub")!.textContent = `${e.peerName} (${shortId(e.peerId)}…)`;
      const d = li.querySelector<HTMLElement>(".detail")!;
      d.textContent = e.detail ?? "";
      d.hidden = !e.detail;
      li.querySelector(".time")!.textContent = fmtTime(e.at);
      return li;
    }),
  );
}

function renderHistory() {
  renderTransfers();
  renderPairingLog();
  const canClear = historyTab === 0 ? transfers.some((t) => t.state !== "run") : pairingLog.length > 0;
  $<MdIconButton>("history-clear").disabled = !canClear;
}

let historyTab = 0;
const historyTabs = $<MdTabs>("history-tabs");
historyTabs.addEventListener("change", () => {
  historyTab = historyTabs.activeTabIndex;
  log(`history tab ${historyTab === 0 ? "transfers" : "pairing"}`);
  transferList.hidden = historyTab !== 0;
  pairingList.hidden = historyTab !== 1;
  renderHistory();
});

$("history-clear").addEventListener("click", async () => {
  const isTransfers = historyTab === 0;
  const ok = await confirmDialog({
    title: isTransfers ? "Clear all transfer history?" : "Clear all pairing history?",
    body: isTransfers
      ? "Transfers in progress are kept. Saved files are not deleted. This can't be undone."
      : "Paired devices are not removed. This can't be undone.",
    confirmLabel: "Clear",
    tone: "critical",
  });
  if (!ok) return;
  if (isTransfers) {
    log(`clear transfer history (${transfers.length} rows)`);
    for (let i = transfers.length - 1; i >= 0; i--) if (transfers[i].state !== "run") transfers.splice(i, 1);
  } else {
    log(`clear pairing history (${pairingLog.length} rows)`);
    pairingLog.length = 0;
  }
  renderHistory();
});
renderHistory();

// ---------------- Send (files, folder, text) ----------------

const sendMenu = $<MdDialog>("send-menu"); // only a choice, so a scrim tap may close it (md-dialog default)
const pickFiles = $<HTMLInputElement>("pick-files");
const pickFolder = $<HTMLInputElement>("pick-folder");
let sendTarget: Peer | null = null;

// browsers without folder picking (webkitdirectory) don't get the choice
if (!("webkitdirectory" in pickFolder)) $("send-folder-choice").hidden = true;

function openSendMenu(peer: Peer) {
  log(`send menu for ${peer.name} (${shortId(peer.id)})`);
  sendTarget = peer;
  $("send-menu-title").textContent = `Send to ${peer.name}`;
  openDialog(sendMenu);
}

/**
 * The picker opens synchronously inside the item's click (like FilePizza). Calling click() from the menu's close
 * event (another task) isn't treated as a user action, and Safari etc. don't show the picker.
 */
function openPicker(input: HTMLInputElement, what: string) {
  const peer = sendTarget;
  if (!peer) return;
  input.value = "";
  input.click();
  void sendMenu.close("picked");
  log(`send: ${what} picker opened (to ${peer.name})`);
}

$("send-files-choice").addEventListener("click", () => openPicker(pickFiles, "files"));
$("send-folder-choice").addEventListener("click", () => openPicker(pickFolder, "folder"));
$("send-menu-cancel").addEventListener("click", () => void sendMenu.close("cancel"));
$("send-text-choice").addEventListener("click", () => {
  const peer = sendTarget;
  void sendMenu.close("text");
  if (peer) openTextDialog(peer);
});

pickFiles.addEventListener("change", () => {
  const peer = sendTarget;
  const list = [...(pickFiles.files ?? [])];
  log(`send: ${list.length} files picked`);
  if (!peer || list.length === 0) return;
  void startSend(peer, list.map((file) => ({ file, relPath: file.name })), []);
});

pickFolder.addEventListener("change", () => {
  const peer = sendTarget;
  const list = [...(pickFolder.files ?? [])];
  log(`send: folder picked, ${list.length} files (${list[0]?.webkitRelativePath.split("/")[0] ?? "-"})`);
  if (!peer) return;
  if (list.length === 0) {
    // empty folders aren't sent (like the app)
    snack("The folder has no files.");
    return;
  }
  // webkitRelativePath is "<folder>/<relative path>"; the folder structure is sent as is (like the app)
  void startSend(peer, list.map((file) => ({ file, relPath: file.webkitRelativePath || file.name })), []);
});

const textDialog = $<MdDialog>("text-dialog");
keepOpenOnScrim(textDialog); // don't lose typed text to a scrim tap
const textInput = $<MdOutlinedTextField>("text-input");
const textSend = $<MdTextButton>("text-send");
const textTools = attachPasteClear(textInput, log, () => (textSend.disabled = textInput.value.trim().length === 0));
let textTarget: Peer | null = null;

function openTextDialog(peer: Peer) {
  textTarget = peer;
  $("text-title").textContent = `Send text to ${peer.name}`;
  textInput.value = "";
  textTools.refresh();
  textSend.disabled = true;
  openDialog(textDialog);
  textDialog.addEventListener("opened", () => textInput.focus(), { once: true });
}

textDialog.addEventListener("closed", () => {
  const peer = textTarget;
  textTarget = null;
  if (textDialog.returnValue === "ok" && peer && textInput.value.trim().length > 0) {
    log(`send: text (${textInput.value.length} chars) -> ${peer.name}`);
    void startSend(peer, [], [textInput.value]);
  }
});

function toSendFile(x: { file: File; relPath: string }): SendFile {
  return {
    item: { relPath: x.relPath, size: x.file.size, mtime: x.file.lastModified || Date.now() },
    read: async (pos, len) => new Uint8Array(await x.file.slice(pos, pos + len).arrayBuffer()),
  };
}

/** Sends text or files. If the device hasn't added this browser, requests pairing and tries once more after approval. */
async function startSend(peer: Peer, picked: { file: File; relPath: string }[], texts: string[]) {
  const files = picked.map(toSendFile);
  const totalBytes = files.reduce((a, f) => a + f.item.size, 0);
  const fileName =
    files.length === 0
      ? `Text (${plural(texts[0]?.length ?? 0, "character")})`
      : files.length === 1
        ? (files[0].item.relPath.split("/").pop() ?? files[0].item.relPath)
        : plural(files.length, "item");
  const t = newTransfer("send", fileName, peer.id, peer.name, totalBytes);
  log(`send -> ${peer.name}: ${files.length} files ${fmtSize(totalBytes)}, ${texts.length} texts`);
  if (files.length > 0) {
    snack(`Sending ${plural(files.length, "item")} to ${peer.name}.`, { action: "Show", onAction: openHistory });
  }

  const attempt = () =>
    sendFiles(client(peer.id), files, texts, {
      signal: t.abort.signal,
      onAccepted: () => {
        t.waiting = files.length === 0;
        renderHistory();
      },
      onProgress: (p) => {
        t.waiting = false;
        t.done = p.done;
        renderTransfers();
      },
    });

  try {
    let d: Decision;
    try {
      d = await attempt();
    } catch (e) {
      // the device hasn't added this browser: request pairing and try once more after approval
      if (!(e instanceof RemoteError) || e.message !== ERR_NOT_PAIRED) throw e;
      const p = await requestTo(peer);
      if (p !== "accepted") {
        t.state = "err";
        t.error = "Not paired on the other device.";
        return;
      }
      d = await attempt();
    }
    log(`send -> ${peer.name}: ${d}`);
    if (d === "accepted") {
      t.state = "ok";
      t.done = totalBytes;
      if (files.length === 0) snack(`Sent to ${peer.name}.`);
    } else {
      t.state = "err";
      t.error = d === "rejected" ? "The other device declined." : "No response from the other device.";
      snack(d === "rejected" ? `${peer.name} declined.` : `No response from ${peer.name}.`);
    }
  } catch (e) {
    if (e instanceof CancelledError || t.abort.signal.aborted) {
      t.state = "cancel";
      log(`send -> ${peer.name}: cancelled (the other device keeps what it got; sending the same again resumes)`);
    } else {
      t.state = "err";
      t.error = handlePeerError(peer, e) ? "Not paired on the other device." : errMsg(e);
      log(`send -> ${peer.name} failed: ${errMsg(e)}`);
      snack(`Couldn't send to ${peer.name}: ${t.error}`, { action: "Show", onAction: openHistory });
    }
  } finally {
    t.waiting = false;
    renderHistory();
  }
}

// ---------------- Received text ----------------

// a scrim tap is the same as Close (the text has arrived; nothing is lost; md-dialog default)
const incomingDialog = $<MdDialog>("incoming-dialog");
const incomingQueue: IncomingText[] = [];
let incomingShowing: IncomingText | null = null;

function showIncomingText(t: IncomingText) {
  incomingQueue.push(t);
  if (!incomingShowing) nextIncoming();
}
function nextIncoming() {
  const t = incomingQueue.shift();
  incomingShowing = t ?? null;
  if (!t) return;
  const chars = t.texts.reduce((a, x) => a + x.length, 0);
  $("incoming-title").textContent = `Text from ${t.peerName}`;
  $("incoming-question").textContent = `Copy text (${plural(chars, "character")}) to the clipboard?`;
  const box = $("incoming-texts");
  box.innerHTML = "";
  for (const text of t.texts) {
    const pre = document.createElement("pre");
    pre.className = "text-box";
    pre.textContent = text;
    box.appendChild(pre);
  }
  openDialog(incomingDialog);
}
// copy inside the click (after the dialog has closed, Safari may not count it as a user action)
$("incoming-copy").addEventListener("click", () => {
  const t = incomingShowing;
  if (t) void copyText(t.texts.join("\n"), "Copied to the clipboard.");
  void incomingDialog.close("copy");
});
incomingDialog.addEventListener("closed", () => {
  incomingShowing = null;
  nextIncoming();
});

// ---------------- Receiving files (other device -> this browser) ----------------

const filesDialog = $<MdDialog>("files-dialog");
keepOpenOnScrim(filesDialog); // the other device is waiting, so a scrim tap doesn't close it
const fileOfferQueue: IncomingFiles[] = [];
let fileOfferShowing: IncomingFiles | null = null;
const receiving = new Map<string, Transfer>();

function showFileOffer(o: IncomingFiles) {
  fileOfferQueue.push(o);
  if (!fileOfferShowing) nextFileOffer();
}

function nextFileOffer() {
  const o = fileOfferQueue.shift();
  fileOfferShowing = o ?? null;
  if (!o) return;
  $("files-title").textContent = `Files from ${o.peerName}`;
  $("files-question").textContent = `Accept ${plural(o.items.length, "item")} (${fmtSize(o.totalBytes)} total)?`;
  const list = $("files-list");
  list.innerHTML = "";
  for (const it of o.items) {
    const li = document.createElement("li");
    li.innerHTML = `${icon("draft")}<div class="grow"><div class="name"></div><div class="sub"></div></div>`;
    li.querySelector(".name")!.textContent = it.relPath;
    li.querySelector(".sub")!.textContent = fmtSize(it.size);
    list.appendChild(li);
  }
  $("files-note").textContent =
    "Each file is saved as a browser download (folders aren't kept). " +
    (o.texts.length > 0 ? "The text sent along is shown when you accept. " : "") +
    `Declined automatically after ${CONSENT_TIMEOUT_MS / 1000} seconds.`;
  openDialog(filesDialog);
}

/** Closes an offer that was settled elsewhere (timed out). */
function closeFileOffer(token: string) {
  const i = fileOfferQueue.findIndex((x) => x.token === token);
  if (i >= 0) fileOfferQueue.splice(i, 1);
  if (fileOfferShowing?.token === token && filesDialog.open) void filesDialog.close("resolved");
}

filesDialog.addEventListener("closed", () => {
  const o = fileOfferShowing;
  const v = filesDialog.returnValue;
  fileOfferShowing = null;
  // "resolved" = settled elsewhere (timeout); anything but Accept declines
  if (o && v !== "resolved") {
    if (v === "accept") void startReceive(o);
    else services.decideFiles(o.token, false);
  }
  nextFileOffer();
});

async function startReceive(o: IncomingFiles) {
  const fileName = o.items.length === 1 ? (o.items[0].relPath.split("/").pop() ?? o.items[0].relPath) : plural(o.items.length, "item");
  const t = newTransfer("receive", fileName, o.peerId, o.peerName, o.totalBytes);
  t.abort.signal.addEventListener("abort", () => {
    services.cancelReceive(o.token);
    if (t.state === "run") {
      t.state = "cancel";
      renderHistory();
    }
  });
  receiving.set(o.token, t);
  log(`receive from ${o.peerName}: ${o.items.length} files ${fmtSize(o.totalBytes)} (temporary storage: ${await tempStorageKind()})`);
  services.decideFiles(o.token, true);
  snack(`Receiving ${plural(o.items.length, "item")} from ${o.peerName}.`, { action: "Show", onAction: openHistory });
}

/** Sink for one file: a browser download named after the file (folders aren't kept). */
async function openIncomingSink(_o: IncomingFiles, item: OfferItem) {
  const segs = item.relPath.split("/").filter((x) => x.length > 0);
  return new DownloadFileSink(sanitize(segs[segs.length - 1] ?? "file"));
}

/** Avoids characters that aren't allowed in file names. */
function sanitize(s: string): string {
  const cleaned = s.replace(/[/\\:*?"<>|\u0000]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "_";
}

function onReceiveProgress(o: IncomingFiles, p: ReceiveProgress) {
  const t = receiving.get(o.token);
  if (!t || t.state !== "run") return;
  t.waiting = false;
  t.done = p.done;
  renderTransfers();
}

function onReceiveDone(o: IncomingFiles, p: ReceiveProgress) {
  const t = receiving.get(o.token);
  receiving.delete(o.token);
  if (!t) return;
  t.state = "ok";
  t.done = p.done;
  t.waiting = false;
  renderHistory();
  log(`receive from ${o.peerName}: done (${o.items.length} files)`);
  snack(`Received ${plural(o.items.length, "item")} from ${o.peerName}.`);
}

function onReceiveFailed(o: IncomingFiles, relPath: string, reason: string) {
  const t = receiving.get(o.token);
  receiving.delete(o.token);
  if (!t) return;
  t.waiting = false;
  if (t.state === "run") {
    t.state = "err";
    t.error = `${relPath}: ${reason}`;
  }
  renderHistory();
}

// closing the tab stops transfers, so ask first
window.addEventListener("beforeunload", (ev) => {
  if (transfers.some((t) => t.state === "run")) ev.preventDefault();
});

// ---------------- Screens: Device Hub | Settings, and the History / Logs detail screens ----------------

function showScreen(s: Screen) {
  screen = s;
  if (s === "hub" || s === "settings") tabScreen = s;
  const detail = s === "history" || s === "logs";
  $("tab-hub").hidden = s !== "hub";
  $("tab-settings").hidden = s !== "settings";
  $("history").hidden = s !== "history";
  $("logs").hidden = s !== "logs";
  document.body.dataset.screen = s;
  document.body.classList.toggle("detail-open", detail);
  addMenu.open = false;
  if (s === "logs") renderLog();
  if (s === "history") renderHistory();
  window.scrollTo(0, 0);
  restartPresence();
}

$("nav").addEventListener("navigation-bar-activated", (e) => {
  const i = (e as CustomEvent<{ activeIndex: number }>).detail.activeIndex;
  log(`tab -> ${i === 0 ? "Device Hub" : "Settings"}`);
  showScreen(i === 0 ? "hub" : "settings");
});

/** Detail screens push a browser history entry so Back (button, gesture) returns to the tab. */
function openDetail(s: "history" | "logs") {
  if (screen === s) return;
  if (screen === "history" || screen === "logs") history.replaceState({ screen: s }, "");
  else history.pushState({ screen: s }, "");
  showScreen(s);
}
function closeDetail() {
  if (history.state?.screen) history.back();
  else showScreen(tabScreen);
}
window.addEventListener("popstate", () => {
  const s = history.state?.screen as Screen | undefined;
  showScreen(s === "history" || s === "logs" ? s : tabScreen);
});
// a reload while on a detail screen starts on the tab again
if (history.state?.screen) history.replaceState(null, "");

function openHistory() {
  log("open history");
  openDetail("history");
}
$("open-history").addEventListener("click", openHistory);
$("history-back").addEventListener("click", closeDetail);
$("open-logs").addEventListener("click", () => {
  log("open logs");
  openDetail("logs");
});
$("logs-back").addEventListener("click", closeDetail);
$("logs-copy").addEventListener("click", () => void copyText(logLines.join("\n")));
$("logs-clear").addEventListener("click", () => {
  logLines.length = 0;
  renderLog();
});

// ---------------- Presence checks (every 30 s while Device Hub is shown and the tab is visible) ----------------

let presenceTimer: number | undefined;
let presenceRunning = false;
let presenceAgain = false;

function presenceActive(): boolean {
  return screen === "hub" && document.visibilityState === "visible" && node.status.state === "online";
}

/** Starts a round now (if active) and schedules the next ones. A round already running is followed by one more. */
function restartPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  if (!presenceActive()) return;
  if (presenceRunning) {
    presenceAgain = true;
    return;
  }
  void runPresence();
}

async function runPresence() {
  presenceRunning = true;
  try {
    await presence.checkAll();
  } catch (e) {
    log(`presence check failed: ${errMsg(e)}`);
  } finally {
    presenceRunning = false;
  }
  renderPeers();
  if (presenceAgain) {
    presenceAgain = false;
    restartPresence();
    return;
  }
  if (presenceActive()) presenceTimer = window.setTimeout(() => void runPresence(), INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  log(`presence checks ${document.visibilityState === "visible" ? "on" : "off"} (tab ${document.visibilityState})`);
  restartPresence();
});

// ---------------- start ----------------

showScreen("hub");
renderPeers();
renderStatus();

// remove what the last visit left in temporary storage
void clearTempFiles().then(
  async (n) => log(`temporary storage: ${await tempStorageKind()}${n > 0 ? ` (removed ${n} leftover files)` : ""}`),
  (e) => log(`temporary storage cleanup failed: ${errMsg(e)}`),
);

void node.start();
