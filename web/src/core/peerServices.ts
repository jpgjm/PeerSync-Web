/**
 * Entry point for what other devices send: offers (text, files), pairing requests, unpair notices and
 * presence checks (the PeerServices implementation). The parts of the app's data/Incoming.kt and
 * data/Pairing.kt that the browser needs.
 *
 * - Text-only offer: the text comes inside the offer, so it is ACCEPTED at once and the UI shows it.
 * - Offer with files: PENDING; the UI asks the user, and it is REJECTED automatically after CONSENT_TIMEOUT_MS
 *   (120 s like the app). After acceptance, each PUT is written to a sink (DownloadSink) from the UI, one file
 *   at a time. Texts sent along are shown when the user accepts.
 * - Pairing request: ACCEPTED at once if already paired. Otherwise PENDING; the UI asks the user, and it is
 *   REJECTED automatically after CONSENT_TIMEOUT_MS (120 s like the app).
 * - Unpair: removes the device if paired and tells the UI. OK even if not paired (so the other device clears its
 *   record). Being unpaired by the other side, nothing is recorded in this browser's "unpaired" list.
 * - Ping: keeps the device's name current and replies with this browser's name.
 */
import type { OfferItem, OfferResponse } from "../proto/wire";
import { OFFER_ACCEPTED, OFFER_PENDING, OFFER_REJECTED, ProtocolError } from "../proto/wire";
import type { PeerServices } from "../proto/fileServer";
import type { DownloadSink } from "../proto/remoteClient";
import type { Settings } from "./settings";

/** How long consent is awaited (same as the app's CONSENT_TIMEOUT_MS). */
export const CONSENT_TIMEOUT_MS = 120_000;

export interface IncomingText {
  token: string;
  peerId: string;
  peerName: string;
  texts: string[];
}

/** An offer with files (used by the consent dialog and the transfer row). */
export interface IncomingFiles {
  token: string;
  peerId: string;
  peerName: string;
  items: OfferItem[];
  texts: string[];
  totalBytes: number;
}

export interface ReceiveProgress {
  /** Bytes received in total (including what was already there when resuming). */
  done: number;
  total: number;
  /** Files finished. */
  files: number;
  /** relPath of the file being received. */
  current: string;
}

/** Error returned to the sender when receiving is cancelled here (same text as the app). */
export const ERR_RECEIVE_CANCELLED = "Cancelled by the receiver.";

/** Pairing history entries this side records (the app's PairingLogKind, the ones the browser uses). */
export type PairingLogKind =
  | "requestSent"
  | "sentAccepted"
  | "sentRejected"
  | "sentFailed"
  | "requestReceived"
  | "receivedAccepted"
  | "receivedRejected"
  | "receivedTimedOut"
  | "unpairedByMe"
  | "unpairedByPeer";

export interface PairRequest {
  token: string;
  peerId: string;
  name: string;
}

export interface PeerServicesUi {
  /** Text arrived (show it). */
  onText(t: IncomingText): void;
  /** An offer with files arrived (ask the user). Answer with decideFiles(). */
  onFileOffer(o: IncomingFiles): void;
  /** The file offer was settled (timed out or decided). Close the dialog. */
  onFileOfferResolved(token: string): void;
  /** Provides the sink for one file of an accepted offer. */
  openSink(o: IncomingFiles, item: OfferItem): Promise<DownloadSink>;
  /** Receive progress (after each write and each finished file). */
  onReceiveProgress(o: IncomingFiles, p: ReceiveProgress): void;
  /** Every file of the offer has been received. */
  onReceiveDone(o: IncomingFiles, p: ReceiveProgress): void;
  /** One file ended midway (sender stopped, connection lost, save failed, or cancelled here). */
  onReceiveFailed(o: IncomingFiles, relPath: string, reason: string): void;
  /** A pairing request arrived (ask the user). Answer with decide(). */
  onPairRequest(r: PairRequest): void;
  /** The request was settled (timed out or decided). Close the dialog. */
  onPairResolved(token: string): void;
  /** The other device unpaired and it was removed here too. */
  onUnpaired(peerId: string, name: string): void;
  /** The paired list changed (added, removed or renamed). */
  onPeersChanged(): void;
  /** A paired device sent a PING (it is online and has this browser in its list). */
  onPing(peerId: string): void;
  /** Adds a pairing history entry. */
  onPairingLog(kind: PairingLogKind, peerId: string, name: string, detail?: string): void;
}

interface PendingPair extends PairRequest {
  status: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface FileBatch extends IncomingFiles {
  status: number;
  timer?: ReturnType<typeof setTimeout>;
  /** relPaths received. */
  received: Set<string>;
  /** relPath -> bytes received (including what was already there when resuming). */
  bytes: Map<string, number>;
  cancelled: boolean;
}

export function newToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class BrowserPeerServices implements PeerServices {
  /** token of a text offer -> device ID (to answer OFFER_STATUS; always ACCEPTED). */
  private texts = new Map<string, string>();
  private pairs = new Map<string, PendingPair>();
  /** token of an offer with files -> state. */
  private batches = new Map<string, FileBatch>();

  constructor(
    private settings: Settings,
    private ui: PeerServicesUi,
    private log: (msg: string) => void,
    private timeoutMs = CONSENT_TIMEOUT_MS,
  ) {}

  isPaired(peerId: string): boolean {
    return this.settings.isPaired(peerId);
  }

  isUnpaired(peerId: string): boolean {
    return this.settings.isUnpaired(peerId);
  }

  async offer(peerId: string, items: OfferItem[], texts: string[]): Promise<OfferResponse> {
    const token = newToken();
    const peerName = this.settings.peerName(peerId);
    if (items.length > 0) return this.offerFiles(token, peerId, peerName, items, texts);
    this.texts.set(token, peerId.toLowerCase());
    this.log(`text received from ${peerName} (${texts.length})`);
    if (texts.length > 0) this.ui.onText({ token, peerId, peerName, texts });
    return { token, status: OFFER_ACCEPTED };
  }

  private offerFiles(
    token: string,
    peerId: string,
    peerName: string,
    items: OfferItem[],
    texts: string[],
  ): OfferResponse {
    const totalBytes = items.reduce((a, x) => a + x.size, 0);
    const b: FileBatch = {
      token,
      peerId,
      peerName,
      items,
      texts,
      totalBytes,
      status: OFFER_PENDING,
      received: new Set(),
      bytes: new Map(),
      cancelled: false,
    };
    b.timer = setTimeout(() => this.decideFiles(token, false, "timeout"), this.timeoutMs);
    this.batches.set(token, b);
    this.log(`file offer from ${peerName}: ${items.length} files, ${totalBytes} bytes, ${texts.length} texts`);
    this.ui.onFileOffer(publicView(b));
    return { token, status: OFFER_PENDING };
  }

  async offerStatus(peerId: string, token: string): Promise<OfferResponse> {
    const b = this.batches.get(token);
    if (b && b.peerId.toLowerCase() === peerId.toLowerCase()) return { token, status: b.status };
    if (this.texts.get(token) !== peerId.toLowerCase()) throw new ProtocolError("unknown token");
    return { token, status: OFFER_ACCEPTED };
  }

  /** Decision on a file offer (from the UI or the timeout). */
  decideFiles(token: string, accept: boolean, why = accept ? "accepted" : "rejected") {
    const b = this.batches.get(token);
    if (!b || b.status !== OFFER_PENDING) return;
    clearTimeout(b.timer);
    b.status = accept ? OFFER_ACCEPTED : OFFER_REJECTED;
    this.log(`file offer from ${b.peerName}: ${why}`);
    this.ui.onFileOfferResolved(token);
    if (accept) {
      if (b.texts.length > 0) this.ui.onText({ token, peerId: b.peerId, peerName: b.peerName, texts: b.texts });
    } else {
      // keep it long enough for the sender's last OFFER_STATUS, then forget it
      setTimeout(() => this.batches.delete(token), CONSENT_TIMEOUT_MS);
    }
  }

  /** Stops receiving an offer here. Later writes and PUTs are refused with ERR_RECEIVE_CANCELLED. */
  cancelReceive(token: string) {
    const b = this.batches.get(token);
    if (!b || b.cancelled) return;
    b.cancelled = true;
    this.log(`receive cancelled: ${b.peerName}`);
  }

  async put(peerId: string, token: string, item: OfferItem): Promise<DownloadSink> {
    const b = this.batches.get(token);
    if (!b || b.peerId.toLowerCase() !== peerId.toLowerCase()) throw new ProtocolError("unknown token");
    if (b.status !== OFFER_ACCEPTED) throw new ProtocolError("not accepted");
    if (b.cancelled) throw new ProtocolError(ERR_RECEIVE_CANCELLED);
    const offered = b.items.find((x) => x.relPath === item.relPath && x.size === item.size);
    if (!offered) throw new ProtocolError(`not in offer: ${item.relPath}`);
    const inner = await this.ui.openSink(publicView(b), offered);
    return this.trackedSink(b, offered, inner);
  }

  /** Wraps the sink to report progress, completion and failure to the UI. Refuses writes after a cancel. */
  private trackedSink(b: FileBatch, item: OfferItem, inner: DownloadSink): DownloadSink {
    const view = publicView(b);
    const progress = (): ReceiveProgress => ({
      done: [...b.bytes.values()].reduce((a, x) => a + x, 0),
      total: b.totalBytes,
      files: b.received.size,
      current: item.relPath,
    });
    let finished = false;
    return {
      offset: () => inner.offset(),
      start: async (pos) => {
        await inner.start(pos);
        b.bytes.set(item.relPath, pos);
        this.ui.onReceiveProgress(view, progress());
      },
      write: async (chunk) => {
        if (b.cancelled) throw new ProtocolError(ERR_RECEIVE_CANCELLED);
        await inner.write(chunk);
        b.bytes.set(item.relPath, (b.bytes.get(item.relPath) ?? 0) + chunk.length);
        this.ui.onReceiveProgress(view, progress());
      },
      commit: async () => {
        const saved = await inner.commit();
        finished = true;
        b.received.add(item.relPath);
        const p = progress();
        this.log(`received from ${b.peerName}: ${item.relPath} (${p.files}/${b.items.length})`);
        if (b.received.size >= b.items.length) {
          this.ui.onReceiveDone(view, p);
          setTimeout(() => this.batches.delete(b.token), CONSENT_TIMEOUT_MS);
        } else {
          this.ui.onReceiveProgress(view, p);
        }
        return saved;
      },
      abort: async (reason) => {
        if (finished) return;
        finished = true;
        await inner.abort(reason);
        const why = b.cancelled ? ERR_RECEIVE_CANCELLED : (reason ?? "Stopped.");
        this.log(`receive ended midway from ${b.peerName}: ${item.relPath}: ${why}`);
        this.ui.onReceiveFailed(view, item.relPath, why);
      },
    };
  }

  async pair(peerId: string, name: string): Promise<OfferResponse> {
    const label = name.trim() || peerId.slice(0, 10);
    if (this.settings.isPaired(peerId)) {
      // e.g. the other device added this one again; take the name it sends
      if (name.trim()) this.settings.addPeer(peerId, name.trim());
      this.ui.onPeersChanged();
      this.log(`pairing request from ${label} (already paired)`);
      return { token: newToken(), status: OFFER_ACCEPTED };
    }
    // one dialog even if automatic re-requests keep coming
    for (const p of this.pairs.values()) {
      if (p.peerId.toLowerCase() === peerId.toLowerCase() && p.status === OFFER_PENDING) {
        return { token: p.token, status: OFFER_PENDING };
      }
    }
    const req: PendingPair = { token: newToken(), peerId, name: label, status: OFFER_PENDING };
    req.timer = setTimeout(() => this.decide(req.token, false, "timeout"), this.timeoutMs);
    this.pairs.set(req.token, req);
    this.log(`pairing request from ${label}`);
    this.ui.onPairingLog("requestReceived", peerId, label);
    this.ui.onPairRequest({ token: req.token, peerId, name: label });
    return { token: req.token, status: OFFER_PENDING };
  }

  async pairStatus(peerId: string, token: string): Promise<OfferResponse> {
    const p = this.pairs.get(token);
    if (!p || p.peerId.toLowerCase() !== peerId.toLowerCase()) throw new ProtocolError("unknown token");
    return { token, status: p.status };
  }

  /** Decision from the UI (or the timeout). */
  decide(token: string, accept: boolean, why = accept ? "accepted" : "rejected") {
    const p = this.pairs.get(token);
    if (!p || p.status !== OFFER_PENDING) return;
    clearTimeout(p.timer);
    p.status = accept ? OFFER_ACCEPTED : OFFER_REJECTED;
    if (accept) {
      this.settings.addPeer(p.peerId, p.name);
      this.ui.onPeersChanged();
    }
    this.log(`pairing request from ${p.name}: ${why}`);
    this.ui.onPairingLog(accept ? "receivedAccepted" : why === "timeout" ? "receivedTimedOut" : "receivedRejected", p.peerId, p.name);
    this.ui.onPairResolved(token);
    // keep it long enough for the requester's last PAIR_STATUS, then forget it (fixed, whatever the timeout)
    setTimeout(() => this.pairs.delete(token), CONSENT_TIMEOUT_MS);
  }

  async unpair(peerId: string, name: string): Promise<void> {
    // both sides unpaired (the other device unpaired before our notice arrived): just clear the record
    this.settings.clearUnpaired(peerId);
    if (!this.settings.isPaired(peerId)) {
      this.log(`unpair notice from an unpaired device: ${name || peerId.slice(0, 10)}`);
      return;
    }
    const label = this.settings.peerName(peerId);
    this.settings.removePeer(peerId);
    this.log(`unpaired by ${label}: removed here too`);
    this.ui.onPairingLog("unpairedByPeer", peerId, label, "Also removed from this device (notice).");
    this.ui.onPeersChanged();
    this.ui.onUnpaired(peerId, label);
  }

  async ping(peerId: string, name: string): Promise<string> {
    // FileServer lets only paired devices through. Keep their current name (like the app 0.2.36)
    const before = this.settings.peerName(peerId);
    if (this.settings.renamePeer(peerId, name)) {
      this.log(`renamed ${before} -> ${name.trim()} (ping from it)`);
      this.ui.onPeersChanged();
    }
    this.ui.onPing(peerId);
    return this.settings.deviceName;
  }
}

/** The view handed to the UI (without internal state). */
function publicView(b: FileBatch): IncomingFiles {
  return {
    token: b.token,
    peerId: b.peerId,
    peerName: b.peerName,
    items: b.items,
    texts: b.texts,
    totalBytes: b.totalBytes,
  };
}
