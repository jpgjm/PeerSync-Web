/**
 * Server side. Dispatches like the app's proto/FileServer.kt.
 * - OFFER2 / OFFER_STATUS: offers (text, files). Files wait for the user's consent (PENDING).
 * - PUT: receives one file of an accepted offer. The sink (DownloadSink) comes from PeerServices;
 *   it replies with the bytes it already has and receives the rest (same steps as the app's Incoming.kt).
 * - PAIR / PAIR_STATUS / UNPAIR: accepted from unpaired devices too. Other ops get "not paired"
 *   ("unpaired" for devices this browser unpaired).
 * - PING: presence check from a paired device; replies with this browser's name.
 * The shared folder (LIST / GET) was removed; those ops get "unknown op" like in the app.
 */
import {
  CHUNK,
  Decoder,
  decodeRequest,
  encodeError,
  encodeOfferResponse,
  encodeOk,
  encodePingResponse,
  encodePutHeader,
  ERR_NOT_PAIRED,
  ERR_UNPAIRED,
  FrameIn,
  FrameOut,
  OfferItem,
  OfferResponse,
  ProtocolError,
  Request,
} from "./wire";
import type { DownloadSink } from "./remoteClient";

/**
 * Per-device entry points. Implemented by core/peerServices.ts (offers, receiving files, pairing, unpairing).
 * Throwing ProtocolError sends its message back to the other device as ERR.
 */
export interface PeerServices {
  isPaired(peerId: string): boolean;
  /** Whether this browser unpaired the device and the notice hasn't reached it yet (normal requests get "unpaired"). */
  isUnpaired(peerId: string): boolean;
  offer(peerId: string, items: OfferItem[], texts: string[]): Promise<OfferResponse>;
  offerStatus(peerId: string, token: string): Promise<OfferResponse>;
  /**
   * Sink for one file of an accepted offer (token). Throws ProtocolError if the file isn't in the offer,
   * the offer isn't accepted or it was cancelled. Receiving continues from the sink's offset().
   */
  put(peerId: string, token: string, item: OfferItem): Promise<DownloadSink>;
  pair(peerId: string, name: string): Promise<OfferResponse>;
  pairStatus(peerId: string, token: string): Promise<OfferResponse>;
  unpair(peerId: string, name: string): Promise<void>;
  /** Presence check from a paired device. name is its current name; returns this browser's name. */
  ping(peerId: string, name: string): Promise<string>;
}

/** Ops accepted from unpaired devices. */
function allowedUnpaired(r: Request): boolean {
  return r.kind === "pair" || r.kind === "pairStatus" || r.kind === "unpair";
}

/** Checks a relative path and splits it into segments. */
export function segments(relPath: string): string[] {
  const parts = relPath.split("/").filter((s) => s.length > 0);
  for (const p of parts) {
    if (p === ".." || p === "." || p.includes("\\") || p.includes("\u0000"))
      throw new ProtocolError("invalid path");
  }
  return parts;
}

export class FileServer {
  constructor(
    private log?: (msg: string) => void,
    private services?: PeerServices,
  ) {}

  private logMsg(msg: string) {
    this.log?.(msg);
  }

  /**
   * Handles one stream. peerId is the connected device's ID.
   * Without services (tests), every request is answered with "unsupported".
   */
  async handle(input: FrameIn, output: FrameOut, peerId = ""): Promise<void> {
    let req: Request;
    try {
      req = await decodeRequest(new Decoder(input));
    } catch (e) {
      this.logMsg(`bad request: ${msg(e)}`);
      await output.write(encodeError(`bad request: ${msg(e)}`));
      await output.finish();
      return;
    }

    // PING comes every 30 s per device while Device Hub is open, so it isn't logged (like the app)
    if (req.kind !== "ping") this.logMsg(`request ${describe(req)}`);
    try {
      const svc = this.services;
      if (svc && !allowedUnpaired(req) && !svc.isPaired(peerId)) {
        // devices this browser unpaired get "unpaired" so they remove it too (when the notice didn't arrive)
        throw new ProtocolError(svc.isUnpaired(peerId) ? ERR_UNPAIRED : ERR_NOT_PAIRED);
      }
      switch (req.kind) {
        case "offer":
          await output.write(encodeOfferResponse(await this.svc().offer(peerId, req.items, req.texts)));
          break;
        case "offerStatus":
          await output.write(encodeOfferResponse(await this.svc().offerStatus(peerId, req.token)));
          break;
        case "put":
          await this.receiveFile(req, input, output, peerId);
          break;
        case "pair":
          await output.write(encodeOfferResponse(await this.svc().pair(peerId, req.name)));
          break;
        case "pairStatus":
          await output.write(encodeOfferResponse(await this.svc().pairStatus(peerId, req.token)));
          break;
        case "unpair":
          await this.svc().unpair(peerId, req.name);
          await output.write(encodeOk());
          break;
        case "ping":
          await output.write(encodePingResponse(await this.svc().ping(peerId, req.name)));
          break;
      }
    } catch (e) {
      const reply = e instanceof ProtocolError ? e.message : "permission denied";
      this.logMsg(e instanceof ProtocolError ? `request rejected: ${e.message}` : `request failed: ${msg(e)}`);
      try {
        await output.write(encodeError(reply));
      } catch {
        // the other side closed first (e.g. the sender stopped during a PUT); nowhere to reply
        return;
      }
    }

    await output.finish();
  }

  /**
   * PUT: replies with the bytes already held, receives the rest (size - offset bytes), then replies with the result.
   * If the sender stops or the connection drops, the sink is aborted (partial data handled by the sink) and this ends.
   */
  private async receiveFile(
    req: { token: string; relPath: string; size: number; mtime: number },
    input: FrameIn,
    output: FrameOut,
    peerId: string,
  ): Promise<void> {
    if (req.size < 0) throw new ProtocolError(`bad size ${req.size}`);
    segments(req.relPath); // rejects ".." etc.
    const sink = await this.svc().put(peerId, req.token, { relPath: req.relPath, size: req.size, mtime: req.mtime });
    let offset: number;
    try {
      offset = await sink.offset();
      // partial data larger than the file = a different file; start over
      if (offset < 0 || offset > req.size) offset = 0;
      await sink.start(offset);
    } catch (e) {
      await sink.abort(msg(e));
      throw new ProtocolError(`Can't save: ${msg(e)}`);
    }
    this.logMsg(`receive ${req.relPath} size=${req.size} start=${offset}`);
    await output.write(encodePutHeader(offset));

    let left = req.size - offset;
    while (left > 0) {
      const n = Math.min(CHUNK, left);
      let chunk: Uint8Array;
      try {
        chunk = await input.readExact(n);
      } catch (e) {
        // the sender stopped or the connection dropped; the reply can't arrive, so don't send one
        this.logMsg(`receive aborted ${req.relPath}: ${msg(e)}`);
        await sink.abort("The sender stopped or the connection was lost.");
        throw e;
      }
      try {
        await sink.write(chunk);
      } catch (e) {
        await sink.abort(msg(e));
        throw new ProtocolError(msg(e));
      }
      left -= n;
    }
    try {
      const saved = await sink.commit();
      this.logMsg(`receive done ${req.relPath} -> ${saved}`);
    } catch (e) {
      await sink.abort(msg(e));
      throw new ProtocolError(`Can't save: ${msg(e)}`);
    }
    await output.write(encodeOk());
  }

  private svc(): PeerServices {
    if (!this.services) throw new ProtocolError("unsupported");
    return this.services;
  }
}

/** For logs. Text bodies aren't logged, only their length. */
function describe(r: Request): string {
  if (r.kind === "offer")
    return `offer items=${r.items.length} texts=${r.texts.length} chars=${r.texts.reduce((a, t) => a + t.length, 0)}`;
  return JSON.stringify(r);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
