/**
 * PeerSync wire protocol v0 (ALPN: "peersync/0"). Same spec as the app's proto/Wire.kt.
 *
 * One request = one bidirectional stream.
 *  Request:  u8 op + fields -> the sender calls finish()
 *  Response: u8 status (0 = OK, 1 = ERR) + body
 *
 *  OFFER_STATUS : str token            -> str token, u8 offerStatus (the sender polls while waiting for consent)
 *  PUT          : str token, str relPath, i64 size, i64 mtime -> i64 bytes the receiver already has
 *                 -> the sender sends the body from there (size - offset bytes) and finishes
 *                 -> the receiver replies with the save result (OK / ERR)
 *  OFFER2       : u32 count + (str relPath, i64 size, i64 mtime) * count
 *                 + u32 count + (i32 length + UTF-8 text) * count (0 if there is no text)
 *                                      -> str token, u8 offerStatus
 *  PAIR         : str device name      -> str token, u8 offerStatus (pairing request)
 *  PAIR_STATUS  : str token            -> str token, u8 offerStatus
 *  UNPAIR       : str device name      -> (no body, OK only)
 *  PING         : str device name      -> str device name (presence check; both sides learn the current name)
 *
 * Ops 1 / 2 (LIST / GET, the shared folder) were removed with the shared folder (app 0.2.36, web too),
 * and op 3 (the old OFFER without texts) since app 0.2.26. They are answered with "unknown op".
 * Unpaired devices may only send PAIR / PAIR_STATUS / UNPAIR; everything else gets "not paired".
 *
 * All numbers are big-endian. str is u16 length + UTF-8, blob is i32 length + raw bytes.
 * Depends on neither iroh nor the browser.
 */

export const ALPN = "peersync/0";

// 1, 2 (LIST / GET) and 3 (old OFFER) are unused
export const OP_OFFER_STATUS = 4;
export const OP_PUT = 5;
export const OP_OFFER2 = 6;
export const OP_PAIR = 7;
export const OP_PAIR_STATUS = 8;
export const OP_UNPAIR = 9;
export const OP_PING = 10;

/** State of an OFFER / PAIR. */
export const OFFER_PENDING = 0;
export const OFFER_ACCEPTED = 1;
export const OFFER_REJECTED = 2;

export const STATUS_OK = 0;
export const STATUS_ERR = 1;

export const CHUNK = 256 * 1024;
export const MAX_ENTRIES = 200_000;
/** Max device name length (same as the app's Wire.MAX_NAME_CHARS; cut in UTF-16 units). */
export const MAX_NAME_CHARS = 64;

/** Error texts the apps match on. The strings themselves are the contract. */
export const ERR_NOT_PAIRED = "not paired";
export const ERR_UNPAIRED = "unpaired";

/** Receiving side of a stream. Implemented by iroh's WasmRecv and by test pipes. */
export interface FrameIn {
  /** Reads exactly n bytes. Throws at the end of the stream or on errors. */
  readExact(n: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/** Sending side of a stream. */
export interface FrameOut {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  /** Stops sending midway; the other side's read ends with an error. */
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export class ProtocolError extends Error {}

export class RemoteError extends Error {}

/** Builds big-endian frames. */
export class Encoder {
  // kept as a list of byte chunks so long texts (blob) don't break a spread
  private parts: Uint8Array[] = [];
  private size = 0;

  private push(b: Uint8Array): this {
    this.parts.push(b);
    this.size += b.length;
    return this;
  }

  u8(v: number): this {
    return this.push(Uint8Array.of(v & 0xff));
  }

  i32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, false);
    return this.push(b);
  }

  i64(v: number | bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), false);
    return this.push(b);
  }

  str(s: string): this {
    const b = new TextEncoder().encode(s);
    if (b.length > 0xffff) throw new ProtocolError("string too long");
    this.u8((b.length >> 8) & 0xff);
    this.u8(b.length & 0xff);
    return this.push(b);
  }

  /** i32 length + raw bytes (for text bodies; not limited to 64 KiB like str). */
  blob(b: Uint8Array): this {
    this.i32(b.length);
    return this.push(b);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let pos = 0;
    for (const p of this.parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }
}

/** Reads big-endian values from a stream. */
export class Decoder {
  constructor(private src: FrameIn) {}

  async u8(): Promise<number> {
    return (await this.src.readExact(1))[0] & 0xff;
  }

  async i32(): Promise<number> {
    const b = await this.src.readExact(4);
    return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, false);
  }

  /** Reads an i64 as a Number (file sizes and millisecond times fit below 2^53). */
  async i64(): Promise<number> {
    const b = await this.src.readExact(8);
    return Number(new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, false));
  }

  async blob(): Promise<Uint8Array> {
    const len = await this.i32();
    if (len < 0) throw new ProtocolError(`bad blob length ${len}`);
    return len === 0 ? new Uint8Array(0) : await this.src.readExact(len);
  }

  async str(): Promise<string> {
    const hi = await this.u8();
    const lo = await this.u8();
    const len = (hi << 8) | lo;
    if (len === 0) return "";
    return new TextDecoder().decode(await this.src.readExact(len));
  }
}

/** One file of a "Send". relPath uses "/" separators. */
export interface OfferItem {
  relPath: string;
  size: number;
  mtime: number;
}

export type Request =
  | { kind: "offer"; items: OfferItem[]; texts: string[] }
  | { kind: "offerStatus"; token: string }
  | { kind: "put"; token: string; relPath: string; size: number; mtime: number }
  | { kind: "pair"; name: string }
  | { kind: "pairStatus"; token: string }
  | { kind: "unpair"; name: string }
  | { kind: "ping"; name: string };

/** Response to OFFER2 / OFFER_STATUS / PAIR / PAIR_STATUS. */
export interface OfferResponse {
  token: string;
  /** OFFER_PENDING / OFFER_ACCEPTED / OFFER_REJECTED */
  status: number;
}

// ---- encoding / decoding of requests and responses (the app's Codec) ----

export function encodeRequest(r: Request): Uint8Array {
  switch (r.kind) {
    case "offer": {
      if (r.items.length > MAX_ENTRIES || r.texts.length > MAX_ENTRIES)
        throw new ProtocolError("too many items");
      const e = new Encoder().u8(OP_OFFER2).i32(r.items.length);
      for (const x of r.items) e.str(x.relPath).i64(x.size).i64(x.mtime);
      e.i32(r.texts.length);
      const te = new TextEncoder();
      for (const t of r.texts) e.blob(te.encode(t));
      return e.bytes();
    }
    case "offerStatus":
      return new Encoder().u8(OP_OFFER_STATUS).str(r.token).bytes();
    case "put":
      return new Encoder().u8(OP_PUT).str(r.token).str(r.relPath).i64(r.size).i64(r.mtime).bytes();
    case "pair":
      return new Encoder().u8(OP_PAIR).str(takeName(r.name)).bytes();
    case "pairStatus":
      return new Encoder().u8(OP_PAIR_STATUS).str(r.token).bytes();
    case "unpair":
      return new Encoder().u8(OP_UNPAIR).str(takeName(r.name)).bytes();
    case "ping":
      return new Encoder().u8(OP_PING).str(takeName(r.name)).bytes();
  }
}

/** Cuts a device name to MAX_NAME_CHARS (UTF-16 units, like Kotlin's String.take). */
export function takeName(name: string): string {
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

export async function decodeRequest(d: Decoder): Promise<Request> {
  const op = await d.u8();
  switch (op) {
    case OP_OFFER2: {
      const n = await d.i32();
      if (n < 0 || n > MAX_ENTRIES) throw new ProtocolError(`bad item count ${n}`);
      const items: OfferItem[] = [];
      for (let i = 0; i < n; i++)
        items.push({ relPath: await d.str(), size: await d.i64(), mtime: await d.i64() });
      const m = await d.i32();
      if (m < 0 || m > MAX_ENTRIES) throw new ProtocolError(`bad text count ${m}`);
      const texts: string[] = [];
      const td = new TextDecoder();
      for (let i = 0; i < m; i++) texts.push(td.decode(await d.blob()));
      return { kind: "offer", items, texts };
    }
    case OP_OFFER_STATUS:
      return { kind: "offerStatus", token: await d.str() };
    case OP_PUT:
      return {
        kind: "put",
        token: await d.str(),
        relPath: await d.str(),
        size: await d.i64(),
        mtime: await d.i64(),
      };
    case OP_PAIR:
      return { kind: "pair", name: takeName(await d.str()) };
    case OP_PAIR_STATUS:
      return { kind: "pairStatus", token: await d.str() };
    case OP_UNPAIR:
      return { kind: "unpair", name: takeName(await d.str()) };
    case OP_PING:
      return { kind: "ping", name: takeName(await d.str()) };
    default:
      throw new ProtocolError(`unknown op ${op}`);
  }
}

export function encodeError(message: string): Uint8Array {
  const m = message.length > 1000 ? message.slice(0, 1000) : message;
  return new Encoder().u8(STATUS_ERR).str(m).bytes();
}

/** OK response without a body (UNPAIR, PUT trailer). */
export function encodeOk(): Uint8Array {
  return Uint8Array.of(STATUS_OK);
}

export function encodeOfferResponse(r: OfferResponse): Uint8Array {
  return new Encoder().u8(STATUS_OK).str(r.token).u8(r.status).bytes();
}

/** PING response: OK + the receiver's device name. */
export function encodePingResponse(name: string): Uint8Array {
  return new Encoder().u8(STATUS_OK).str(takeName(name)).bytes();
}

/** PUT response header (bytes the receiver already has; the sender continues from there). */
export function encodePutHeader(offset: number): Uint8Array {
  return new Encoder().u8(STATUS_OK).i64(offset).bytes();
}

async function expectOk(d: Decoder): Promise<void> {
  const s = await d.u8();
  if (s === STATUS_OK) return;
  if (s === STATUS_ERR) throw new RemoteError(await d.str());
  throw new ProtocolError(`unknown status ${s}`);
}

export async function readOk(d: Decoder): Promise<void> {
  await expectOk(d);
}

export async function readOfferResponse(d: Decoder): Promise<OfferResponse> {
  await expectOk(d);
  const token = await d.str();
  const status = await d.u8();
  if (status > OFFER_REJECTED) throw new ProtocolError(`bad offer status ${status}`);
  return { token, status };
}

/** PING response: the other device's current name. */
export async function readPingResponse(d: Decoder): Promise<string> {
  await expectOk(d);
  return takeName(await d.str());
}

/** PUT response header (bytes the other device already has = where to continue). */
export async function readPutHeader(d: Decoder, size: number): Promise<number> {
  await expectOk(d);
  const offset = await d.i64();
  if (offset < 0 || offset > size) throw new ProtocolError(`bad offset ${offset} (size ${size})`);
  return offset;
}
