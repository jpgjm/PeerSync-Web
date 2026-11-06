/**
 * iroh node management (like the app's net/IrohNode.kt).
 * - Accept loop: connections from unpaired devices are accepted too (like the app since 0.2.14).
 *   FileServer answers everything except PAIR / PAIR_STATUS / UNPAIR with "not paired" for them.
 * - Each incoming connection runs an accept_bi loop and hands streams to FileServer (with the device ID).
 * - Outgoing connections are cached per device and reused.
 * - start / stop / restart are serialized (like the app 0.2.37): "Restart" pressed while one is running is
 *   ignored, and the UI disables the button while the node is starting or stopping ([busy]).
 */
import { WasmConn, WasmNode, WasmRecv, WasmSend } from "../wasm/peersync_wasm";
import type { FrameIn, FrameOut } from "../proto/wire";
import { FileServer } from "../proto/fileServer";
import type { Settings } from "./settings";
import { shortId } from "./settings";

export type NodeState = "stopped" | "starting" | "online" | "offline" | "error";

export interface NodeStatus {
  state: NodeState;
  /** online: home relay URL / offline: note / error: message. */
  detail?: string;
}

/** Adapts an iroh stream to FrameIn / FrameOut. */
class IrohIn implements FrameIn {
  constructor(private recv: WasmRecv) {}
  async readExact(n: number): Promise<Uint8Array> {
    return await this.recv.read_exact(n);
  }
  async dispose(): Promise<void> {
    this.recv.free();
  }
}

class IrohOut implements FrameOut {
  private finished = false;
  constructor(private send: WasmSend) {}
  async write(bytes: Uint8Array): Promise<void> {
    await this.send.write(bytes);
  }
  async finish(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      this.send.finish();
    }
  }
  async abort(): Promise<void> {
    this.finished = true;
    try {
      this.send.reset(1);
    } catch {
      // already closed
    }
  }
  async dispose(): Promise<void> {
    if (!this.finished) {
      try {
        this.send.finish();
      } catch {
        // already closed
      }
    }
    this.send.free();
  }
}

/** How long one wait for the home relay lasts before the status says "not connected" (it keeps waiting). */
const ONLINE_WAIT_MS = 15_000;

export class PeerSyncNode {
  private node: WasmNode | null = null;
  private outgoing = new Map<string, WasmConn>();
  /** Chain that serializes start / stop / restart. */
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  status: NodeStatus = { state: "stopped" };
  onStatus?: (s: NodeStatus) => void;
  /** Called when [busy] changes (the UI enables / disables "Restart"). */
  onBusy?: (busy: boolean) => void;

  constructor(
    private settings: Settings,
    private server: FileServer,
    private log: (msg: string) => void,
  ) {}

  private setStatus(s: NodeStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  /** True while a start / stop / restart is running. */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Runs op after the ones already queued. */
  private serial(op: () => Promise<void>): Promise<void> {
    const run = async () => {
      this.running++;
      if (this.running === 1) this.onBusy?.(true);
      try {
        await op();
      } finally {
        this.running--;
        if (this.running === 0) this.onBusy?.(false);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  start(): Promise<void> {
    return this.serial(() => this.startInner());
  }

  stop(): Promise<void> {
    return this.serial(() => this.stopInner());
  }

  /**
   * "Restart" button: stops the node and starts a new one with the same key.
   * Ignored (returns false) while a start / stop / restart is running (repeated taps).
   */
  async restart(): Promise<boolean> {
    if (this.busy) {
      this.log("restart ignored: start / stop already running");
      return false;
    }
    this.log("restart");
    await this.restartNow();
    return true;
  }

  /** Restart that must happen (new key, new relay URL): waits for a running start / stop instead of skipping. */
  restartNow(): Promise<void> {
    return this.serial(async () => {
      await this.stopInner();
      await this.startInner();
    });
  }

  private async startInner(): Promise<void> {
    if (this.node) return;
    this.setStatus({ state: "starting" });
    let node: WasmNode;
    try {
      node = await WasmNode.start(this.settings.secretHex, this.settings.relayUrl);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.log(`node start failed: ${m}`);
      this.setStatus({ state: "error", detail: m });
      return;
    }
    this.node = node;
    this.log(`node started: ${shortId(node.id())}…`);
    void this.acceptLoop(node);
    // waiting for the relay doesn't hold the queue (Restart works while it waits)
    void this.waitOnline(node);
  }

  /**
   * Waits for the home relay (the browser needs it). After ONLINE_WAIT_MS without it the status says
   * "not connected" but it keeps waiting and switches to online once connected.
   */
  private async waitOnline(node: WasmNode): Promise<void> {
    let waited = 0;
    while (this.node === node) {
      let ok: boolean;
      try {
        ok = await node.wait_online(ONLINE_WAIT_MS);
      } catch {
        return; // node was stopped and freed
      }
      if (this.node !== node) return;
      if (ok) {
        const relay = node.home_relay() || "-";
        this.log(`connected to relay: ${relay}${waited > 0 ? ` (after ${waited} s)` : ""}`);
        this.setStatus({ state: "online", detail: relay });
        return;
      }
      waited += ONLINE_WAIT_MS / 1000;
      this.log(`still not connected to the relay after ${waited} s (keeps trying)`);
      this.setStatus({ state: "offline", detail: "Not connected to the relay (trying…)" });
    }
  }

  private async stopInner(): Promise<void> {
    const node = this.node;
    this.node = null;
    for (const c of this.outgoing.values()) {
      try {
        c.close(0, "bye");
      } catch {
        // already closed
      }
      c.free();
    }
    this.outgoing.clear();
    if (node) {
      this.log("node stopping");
      await node.shutdown(); // the accept loop ends when accept returns null
      node.free();
    }
    this.setStatus({ state: "stopped" });
  }

  // ---------------- incoming ----------------

  private async acceptLoop(node: WasmNode): Promise<void> {
    while (true) {
      let conn: WasmConn | undefined;
      try {
        conn = await node.accept();
      } catch {
        return;
      }
      if (!conn) return; // shutdown

      const remote = conn.remote_id();
      // presence checks open a connection every 30 s per device, so paired devices are logged at debug level only
      if (!this.settings.isPaired(remote)) {
        this.log(`connection from an unpaired device: ${shortId(remote)}… (only pairing requests and unpair notices are accepted)`);
      }
      void this.serveConnection(conn, remote);
    }
  }

  private async serveConnection(conn: WasmConn, remote: string): Promise<void> {
    try {
      while (true) {
        let pair: [WasmSend, WasmRecv];
        try {
          const arr = await conn.accept_bi();
          pair = [arr[0] as WasmSend, arr[1] as WasmRecv];
        } catch {
          return; // connection closed
        }
        const input = new IrohIn(pair[1]);
        const output = new IrohOut(pair[0]);
        void (async () => {
          try {
            await this.server.handle(input, output, remote);
          } catch (e) {
            this.log(`request failed: ${e instanceof Error ? e.message : e}`);
          } finally {
            await input.dispose();
            await output.dispose();
          }
        })();
      }
    } finally {
      conn.free();
    }
  }

  // ---------------- outgoing ----------------

  private async getOrConnect(peerId: string): Promise<WasmConn> {
    const node = this.node;
    if (!node) throw new Error("The node isn't running");

    const existing = this.outgoing.get(peerId);
    if (existing) {
      if (!existing.is_closed()) return existing;
      this.discard(peerId, existing);
    }

    const conn = await node.connect(peerId);
    // the node may have been stopped (Restart) while connecting
    if (this.node !== node) {
      try {
        conn.close(0, "bye");
      } catch {
        // already closed
      }
      conn.free();
      throw new Error("The node was restarted");
    }
    const raced = this.outgoing.get(peerId);
    if (raced && !raced.is_closed()) {
      // another request connected at the same time: keep the first one
      conn.close(0, "duplicate");
      conn.free();
      return raced;
    }
    this.outgoing.set(peerId, conn);
    return conn;
  }

  /** For RemoteClient: opens one new bidirectional stream. Reconnects once if the cached connection is dead. */
  async openStream(peerId: string): Promise<[FrameOut, FrameIn]> {
    let conn = await this.getOrConnect(peerId);
    let arr: unknown[];
    try {
      arr = await conn.open_bi();
    } catch {
      // the cached connection was dead: connect again and retry once
      this.discard(peerId, conn);
      conn = await this.getOrConnect(peerId);
      arr = await conn.open_bi();
    }
    return [new IrohOut(arr[0] as WasmSend), new IrohIn(arr[1] as WasmRecv)];
  }

  /** Drops the cached connection (the next request connects again). */
  dropConnection(peerId: string, why = "connection lost") {
    const conn = this.outgoing.get(peerId);
    if (!conn) return;
    this.discard(peerId, conn);
    this.log(`dropped the connection to ${this.settings.peerName(peerId)} (${why})`);
  }

  /**
   * Closes and frees a cached connection once. Several requests can hold the same connection; only the
   * one that still finds it in the cache frees it, so it is never freed twice.
   */
  private discard(peerId: string, conn: WasmConn) {
    if (this.outgoing.get(peerId) !== conn) return;
    this.outgoing.delete(peerId);
    try {
      conn.close(0, "stale");
    } catch {
      // already closed
    }
    conn.free();
  }

  /** Path to the device ("relay|85" form). null if not connected. */
  pathSummary(peerId: string): string | null {
    const conn = this.outgoing.get(peerId);
    if (!conn || conn.is_closed()) return null;
    return conn.path_summary();
  }
}
