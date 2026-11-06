/**
 * Presence of paired devices for Device Hub (like the app's data/Presence.kt, 0.2.36).
 * The UI calls checkAll() every INTERVAL_MS while Device Hub is shown and the tab is visible.
 * Each check sends PING:
 *  - answer: online, and the device's current name replaces the saved one (renamed devices stay current)
 *  - "unpaired": that device removed this browser while it was away -> removed here too (onUnpaired)
 *  - "not paired": notPairedThere (no automatic pairing request here; sending still asks as before)
 *  - other errors from the device (e.g. "unknown op" from an old version): online
 *  - no answer in PING_TIMEOUT_MS: the connection may be stale (the device restarted; iroh keeps the old
 *    connection about 30 s), so it is dropped and tried once more on a new one; still nothing = offline
 */
import type { Peer, Settings } from "./settings";
import { ERR_NOT_PAIRED, ERR_UNPAIRED, RemoteError } from "../proto/wire";
import type { RemoteClient } from "../proto/remoteClient";

export type PeerPresence =
  | { kind: "checking" }
  | { kind: "online"; route: string | null }
  | { kind: "notPairedThere" }
  | { kind: "offline" };

/** Time between rounds while Device Hub is shown. */
export const INTERVAL_MS = 30_000;
/** Wait for one PING answer. */
export const PING_TIMEOUT_MS = 10_000;

class PingTimeout extends Error {}

export interface PresenceDeps {
  settings: Settings;
  client(peerId: string): RemoteClient;
  dropConnection(peerId: string, why: string): void;
  /**
   * Whether a transfer with the device is running. Such devices are online and aren't pinged: a ping that
   * times out behind a large transfer would drop (close) the connection the transfer uses.
   */
  transferring(peerId: string): boolean;
  /** "relay|85" form, or null. */
  pathSummary(peerId: string): string | null;
  /** The device answered "unpaired" (it removed this browser): remove it here and tell the user. */
  onUnpaired(peer: Peer): void;
  onChange(): void;
  log(msg: string): void;
}

export class Presence {
  private states = new Map<string, PeerPresence>();

  constructor(private d: PresenceDeps) {}

  /** The device's presence (checking if not checked yet). */
  get(peerId: string): PeerPresence {
    return this.states.get(peerId.toLowerCase()) ?? { kind: "checking" };
  }

  /** Checks every paired device at once and resolves when all have answered or timed out. */
  async checkAll(): Promise<void> {
    const peers = this.d.settings.peers;
    // forget devices that are no longer paired
    for (const id of [...this.states.keys()]) {
      if (!peers.some((p) => p.id.toLowerCase() === id)) this.states.delete(id);
    }
    await Promise.all(peers.map((p) => this.check(p)));
  }

  private async check(peer: Peer): Promise<void> {
    let result: PeerPresence;
    if (this.d.transferring(peer.id)) {
      result = { kind: "online", route: this.route(peer) };
      this.states.set(peer.id.toLowerCase(), result);
      this.d.onChange();
      return;
    }
    try {
      result = await this.ping(peer);
    } catch {
      // timed out
      this.d.log(`${peer.name}: no answer in ${PING_TIMEOUT_MS / 1000} s, retrying on a new connection`);
      this.d.dropConnection(peer.id, "no answer to ping");
      try {
        result = await this.ping(peer);
      } catch {
        this.d.dropConnection(peer.id, "no answer to ping");
        result = { kind: "offline" };
      }
    }
    const key = peer.id.toLowerCase();
    const before = this.states.get(key);
    if (!this.d.settings.isPaired(peer.id)) {
      this.states.delete(key);
      this.d.onChange();
      return;
    }
    if (!before || before.kind !== result.kind) {
      this.d.log(`${peer.name}: ${before?.kind ?? "checking"} -> ${result.kind}`);
    }
    this.states.set(key, result);
    this.d.onChange();
  }

  /** One PING. Throws PingTimeout when there is no answer in time. */
  private async ping(peer: Peer): Promise<PeerPresence> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PingTimeout()), PING_TIMEOUT_MS);
    });
    try {
      const name = await Promise.race([this.d.client(peer.id).ping(this.d.settings.deviceName), timeout]);
      if (this.d.settings.renamePeer(peer.id, name)) this.d.log(`renamed ${peer.name} -> ${name.trim()} (ping answer)`);
      return { kind: "online", route: this.route(peer) };
    } catch (e) {
      if (e instanceof PingTimeout) throw e;
      if (e instanceof RemoteError) {
        if (e.message === ERR_UNPAIRED) {
          this.d.log(`${peer.name}: has unpaired this browser`);
          this.d.onUnpaired(peer);
          return { kind: "offline" };
        }
        if (e.message === ERR_NOT_PAIRED) return { kind: "notPairedThere" };
        this.d.log(`${peer.name}: answered with an error (${e.message}); counted as online`);
        return { kind: "online", route: this.route(peer) };
      }
      // connect failed (node stopped, no route, connection lost)
      this.d.log(`${peer.name}: unreachable (${e instanceof Error ? e.message : e})`);
      this.d.dropConnection(peer.id, "unreachable");
      return { kind: "offline" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A paired device sent a PING, so it is online and has this browser in its list (apps and the browser only
   * ping paired devices). Updates the state at once instead of at the next round: right after pairing, this
   * browser's own first check can reach the other device before it has saved this one ("not paired").
   */
  heardFrom(peerId: string) {
    if (!this.d.settings.isPaired(peerId)) return;
    const key = peerId.toLowerCase();
    const before = this.states.get(key);
    if (before?.kind === "online") return;
    const peer = this.d.settings.peers.find((p) => p.id.toLowerCase() === key);
    this.d.log(`${peer?.name ?? peerId.slice(0, 10)}: ${before?.kind ?? "checking"} -> online (pinged by it)`);
    this.states.set(key, { kind: "online", route: peer ? this.route(peer) : null });
    this.d.onChange();
  }

  /** The path in use, e.g. "Relay 85ms" (the browser always goes through a relay). */
  private route(peer: Peer): string | null {
    const s = this.d.pathSummary(peer.id);
    if (!s) return null;
    const [kind, rtt] = s.split("|");
    const label = kind === "relay" ? "Relay" : kind === "direct" ? "Direct" : null;
    return label ? `${label} ${rtt}ms` : null;
  }
}
