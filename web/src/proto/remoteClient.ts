/**
 * Client side. openStream opens one new bidirectional stream.
 * Same steps as the app's proto/RemoteClient.kt.
 */
import {
  Decoder,
  encodeRequest,
  FrameIn,
  FrameOut,
  OfferItem,
  OfferResponse,
  readOfferResponse,
  readOk,
  readPingResponse,
  readPutHeader,
  RemoteError,
  ProtocolError,
  Request,
} from "./wire";

/** Stream that sends one file of an accepted offer. write from offset, then finish. */
export interface PutSession {
  /** Bytes the other device already has (resume). Send from here. */
  offset: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Done sending; waits for the other device's save result. */
  finish(): Promise<void>;
  /** Stops midway (the other device keeps what it got; sending again resumes). */
  abort(): Promise<void>;
}

export type OpenStream = () => Promise<[FrameOut, FrameIn]>;

/** Sink for one received file. Receiving continues from the position offset() returns. */
export interface DownloadSink {
  /** Size of existing partial data (where we'd like to resume). */
  offset(): Promise<number>;
  /** Start position decided by the sender side (offset may have been corrected). */
  start(pos: number): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  /** Finished. Returns the saved name (for display). */
  commit(): Promise<string>;
  /** Stopped (partial data may be kept). reason is for display and logs. */
  abort(reason?: string): Promise<void>;
}

export class RemoteClient {
  /**
   * @param onConnectionLost called when the connection is dead (e.g. the other device restarted).
   *   The caller drops its cached connection; call() then tries once more.
   */
  constructor(
    private openStream: OpenStream,
    private onConnectionLost?: () => void,
  ) {}

  /**
   * Sends one request and reads the response with read.
   * On a transport error (not an ERR response or a format error) the connection is dropped and the
   * request is tried once more. After the other device restarts, a cached connection can still be opened
   * but fails about 30 s later with "connection lost" (iroh's idle limit on relay paths), so don't give up at once.
   */
  private async call<T>(req: Request, read: (d: Decoder) => Promise<T>): Promise<T> {
    try {
      return await this.callOnce(req, read);
    } catch (e) {
      if (!this.onConnectionLost || e instanceof RemoteError || e instanceof ProtocolError) throw e;
      this.onConnectionLost();
      return await this.callOnce(req, read);
    }
  }

  private async callOnce<T>(req: Request, read: (d: Decoder) => Promise<T>): Promise<T> {
    const [output, input] = await this.openStream();
    try {
      await output.write(encodeRequest(req));
      await output.finish();
      return await read(new Decoder(input));
    } finally {
      await output.dispose();
      await input.dispose();
    }
  }

  /** "Send" offer (OFFER2). items is empty for text only. */
  offer(items: OfferItem[], texts: string[]): Promise<OfferResponse> {
    return this.call({ kind: "offer", items, texts }, readOfferResponse);
  }

  offerStatus(token: string): Promise<OfferResponse> {
    return this.call({ kind: "offerStatus", token }, readOfferResponse);
  }

  /** Pairing request. name is this browser's name (shown in the other device's dialog and saved there). */
  pair(name: string): Promise<OfferResponse> {
    return this.call({ kind: "pair", name }, readOfferResponse);
  }

  pairStatus(token: string): Promise<OfferResponse> {
    return this.call({ kind: "pairStatus", token }, readOfferResponse);
  }

  /** Unpair notice. The other device removes this browser from its list without asking. */
  unpair(name: string): Promise<void> {
    return this.call({ kind: "unpair", name }, readOk);
  }

  /** Presence check. Sends this browser's name and returns the other device's current name. */
  ping(name: string): Promise<string> {
    return this.call({ kind: "ping", name }, readPingResponse);
  }

  /**
   * Starts sending one file of an accepted offer (token).
   * The body follows the request on the same stream, so unlike other requests it isn't finished right away.
   */
  async put(token: string, item: OfferItem): Promise<PutSession> {
    const [output, input] = await this.openStream();
    const close = async () => {
      await output.dispose();
      await input.dispose();
    };
    const d = new Decoder(input);
    let offset: number;
    try {
      await output.write(
        encodeRequest({ kind: "put", token, relPath: item.relPath, size: item.size, mtime: item.mtime }),
      );
      offset = await readPutHeader(d, item.size);
    } catch (e) {
      await close();
      throw e;
    }
    let closed = false;
    return {
      offset,
      write: async (chunk) => {
        try {
          await output.write(chunk);
        } catch (e) {
          // when the receiver stops midway (cancel, save failure) it writes the reason as ERR and stops reading.
          // Report that reason instead of the write error ("stopped by peer")
          throw (await readReason(d)) ?? e;
        }
      },
      finish: async () => {
        try {
          await output.finish();
          await readOk(d);
        } finally {
          closed = true;
          await close();
        }
      },
      abort: async () => {
        if (closed) return;
        closed = true;
        await output.abort();
        await close();
      },
    };
  }
}

/** Reads the reason from the other device's ERR response (null if none). Doesn't wait long. */
async function readReason(d: Decoder): Promise<RemoteError | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2_000));
  const read = readOk(d).then(
    () => null,
    (e) => (e instanceof RemoteError ? e : null),
  );
  return await Promise.race([read, timeout]);
}
