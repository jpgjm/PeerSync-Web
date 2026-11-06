/**
 * Checks the protocol over in-memory pipes (like the app's ProtocolTest.kt).
 * FileServer is connected straight to the encoder / decoder to check wire-compatible behavior.
 */
import { describe, expect, it } from "vitest";
import {
  Decoder,
  encodeError,
  encodePingResponse,
  encodeRequest,
  FrameIn,
  FrameOut,
  readOk,
  readPingResponse,
  RemoteError,
} from "./wire";
import { FileServer, segments } from "./fileServer";

/** One-way in-memory pipe. */
export class Pipe {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private aborted = false;
  private waiters: (() => void)[] = [];

  out: FrameOut = {
    write: async (bytes) => {
      this.chunks.push(bytes.slice());
      this.wake();
    },
    finish: async () => {
      this.closed = true;
      this.wake();
    },
    abort: async () => {
      this.aborted = true;
      this.closed = true;
      this.wake();
    },
    dispose: async () => {},
  };

  in_: FrameIn = {
    readExact: async (n) => {
      const out = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        if (this.chunks.length === 0) {
          if (this.aborted) throw new Error("stream reset");
          if (this.closed) throw new Error("unexpected EOF");
          await new Promise<void>((r) => this.waiters.push(r));
          continue;
        }
        const head = this.chunks[0];
        const take = Math.min(head.length, n - got);
        out.set(head.subarray(0, take), got);
        got += take;
        if (take === head.length) this.chunks.shift();
        else this.chunks[0] = head.subarray(take);
      }
      return out;
    },
    dispose: async () => {},
  };

  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    ws.forEach((w) => w());
  }
}

/** Lets FileServer handle one request and returns a Decoder for the response. */
async function roundTrip(server: FileServer, requestBytes: Uint8Array): Promise<Decoder> {
  const reqPipe = new Pipe();
  const resPipe = new Pipe();
  await reqPipe.out.write(requestBytes);
  await reqPipe.out.finish();
  const serving = server.handle(reqPipe.in_, resPipe.out);
  const d = new Decoder(resPipe.in_);
  await serving;
  return d;
}

describe("removed shared folder ops", () => {
  it("LIST (1) and GET (2) are answered with unknown op, like the app 0.2.36", async () => {
    for (const op of [1, 2, 3]) {
      // op + an empty str (LIST "" / the start of GET)
      const d = await roundTrip(new FileServer(), Uint8Array.of(op, 0, 0));
      await expect(readOk(d)).rejects.toThrow(new RemoteError(`bad request: unknown op ${op}`));
    }
  });
});

describe("segments", () => {
  it("checks and splits", () => {
    expect(segments("a/b/c")).toEqual(["a", "b", "c"]);
    expect(segments("/a//b/")).toEqual(["a", "b"]);
    expect(() => segments("a/../b")).toThrow();
    expect(() => segments("a/./b")).toThrow();
    expect(() => segments("a\\b")).toThrow();
  });
});

describe("encoding matches the apps byte for byte", () => {
  it("PAIR request", () => {
    // op=7, len=0x0003, "abc"
    expect([...encodeRequest({ kind: "pair", name: "abc" })]).toEqual([7, 0, 3, 0x61, 0x62, 0x63]);
  });

  it("PING request: op 10 + the sender's name", () => {
    expect([...encodeRequest({ kind: "ping", name: "Pixel" })]).toEqual([10, 0, 5, 0x50, 0x69, 0x78, 0x65, 0x6c]);
  });

  it("PING response: OK + the receiver's name (UTF-8)", async () => {
    const bytes = encodePingResponse("Gerät");
    // status 0, len 6 ("ä" is 2 bytes), "Gerät"
    expect([...bytes]).toEqual([0, 0, 6, 0x47, 0x65, 0x72, 0xc3, 0xa4, 0x74]);
    const p = new Pipe();
    await p.out.write(bytes);
    await p.out.finish();
    expect(await readPingResponse(new Decoder(p.in_))).toBe("Gerät");
  });

  it("ERR response", () => {
    expect([...encodeError("no")]).toEqual([1, 0, 2, 0x6e, 0x6f]);
  });
});
