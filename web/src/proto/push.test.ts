/**
 * Tests for text send/receive (OFFER2 / OFFER_STATUS) and pairing (PAIR / PAIR_STATUS / UNPAIR).
 * Connects FileServer + BrowserPeerServices directly to RemoteClient over in-memory pipes.
 * Checks that the bytes match the device app's Wire.kt (0.2.26 and later).
 */
import { describe, expect, it } from "vitest";
import {
  decodeRequest,
  Decoder,
  encodeError,
  encodeOfferResponse,
  encodeOk,
  encodeRequest,
  ERR_NOT_PAIRED,
  ERR_UNPAIRED,
  FrameIn,
  FrameOut,
  OFFER_ACCEPTED,
  OFFER_PENDING,
  OFFER_REJECTED,
  RemoteError,
  readOfferResponse,
} from "./wire";
import { FileServer } from "./fileServer";
import { DownloadSink, RemoteClient } from "./remoteClient";
import {
  BrowserPeerServices,
  ERR_RECEIVE_CANCELLED,
  IncomingFiles,
  IncomingText,
  PairRequest,
  ReceiveProgress,
} from "../core/peerServices";
import { CancelledError, notifyUnpair, requestPair, SendFile, sendFiles, sendText, waitDecision } from "../core/outgoing";
import { Encoder } from "./wire";
import type { Settings } from "../core/settings";

class Pipe {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  out: FrameOut = {
    write: async (b) => {
      this.chunks.push(b.slice());
      this.wake();
    },
    finish: async () => {
      this.closed = true;
      this.wake();
    },
    abort: async () => {
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

/** Stand-in for Settings (no wasm or localStorage). */
function fakeSettings(paired: Record<string, string> = {}, unpairedIds: string[] = []) {
  const peers = new Map(Object.entries(paired).map(([k, v]) => [k.toLowerCase(), v]));
  const unpaired = new Set(unpairedIds.map((x) => x.toLowerCase()));
  return {
    isPaired: (id: string) => peers.has(id.toLowerCase()),
    peerName: (id: string) => peers.get(id.toLowerCase()) ?? id.slice(0, 6),
    addPeer: (id: string, name?: string | null) => {
      peers.set(id.toLowerCase(), name ?? id);
      unpaired.delete(id.toLowerCase());
    },
    removePeer: (id: string) => void peers.delete(id.toLowerCase()),
    isUnpaired: (id: string) => unpaired.has(id.toLowerCase()),
    markUnpaired: (id: string) => void unpaired.add(id.toLowerCase()),
    clearUnpaired: (id: string) => void unpaired.delete(id.toLowerCase()),
    renamePeer: (id: string, name: string) => {
      const n = name.trim();
      if (!n || !peers.has(id.toLowerCase()) || peers.get(id.toLowerCase()) === n) return false;
      peers.set(id.toLowerCase(), n);
      return true;
    },
    deviceName: "Chrome (Android)",
    peers,
    unpaired,
  };
}

/**
 * Test sink. Keeps the contents per relPath in store (keeps partial data on abort, to test resuming).
 */
class MemStore {
  files = new Map<string, Uint8Array>();
  aborted: { relPath: string; reason?: string }[] = [];
  sink(relPath: string): DownloadSink {
    let buf: Uint8Array[] = [];
    const store = this;
    return {
      offset: async () => store.files.get(relPath)?.length ?? 0,
      start: async (pos) => {
        const have = store.files.get(relPath) ?? new Uint8Array(0);
        buf = [have.slice(0, pos)];
      },
      write: async (c) => {
        buf.push(c.slice());
        store.files.set(relPath, concat(buf));
      },
      commit: async () => {
        store.files.set(relPath, concat(buf));
        return relPath;
      },
      abort: async (reason) => {
        store.aborted.push({ relPath, reason });
      },
    };
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

const ME = "a".repeat(64);
const PEER = "b".repeat(64);

function setup(
  paired: Record<string, string>,
  timeoutMs = 120_000,
  unpairedIds: string[] = [],
  /** Automatic answer to file offers (no answer if undefined). */
  autoDecide?: boolean,
) {
  const st = fakeSettings(paired, unpairedIds);
  const store = new MemStore();
  const ev = {
    texts: [] as IncomingText[],
    pairs: [] as PairRequest[],
    resolved: [] as string[],
    unpaired: [] as string[],
    logs: [] as string[],
    pings: [] as string[],
    fileOffers: [] as IncomingFiles[],
    fileResolved: [] as string[],
    progress: [] as ReceiveProgress[],
    done: [] as ReceiveProgress[],
    failed: [] as { relPath: string; reason: string }[],
  };
  let services!: BrowserPeerServices;
  services = new BrowserPeerServices(
    st as unknown as Settings,
    {
      onText: (t) => ev.texts.push(t),
      onFileOffer: (o) => {
        ev.fileOffers.push(o);
        if (autoDecide !== undefined) setTimeout(() => services.decideFiles(o.token, autoDecide), 0);
      },
      onFileOfferResolved: (t) => ev.fileResolved.push(t),
      openSink: async (_o, item) => store.sink(item.relPath),
      onReceiveProgress: (_o, p) => ev.progress.push(p),
      onReceiveDone: (_o, p) => ev.done.push(p),
      onReceiveFailed: (_o, relPath, reason) => ev.failed.push({ relPath, reason }),
      onPairRequest: (r) => ev.pairs.push(r),
      onPairResolved: (t) => ev.resolved.push(t),
      onUnpaired: (_id, name) => ev.unpaired.push(name),
      onPeersChanged: () => {},
      onPing: (id) => ev.pings.push(id),
      onPairingLog: (kind) => ev.logs.push(kind),
    },
    () => {},
    timeoutMs,
  );
  const server = new FileServer(undefined, services);
  // The client connects to ME (this browser) as PEER
  const client = new RemoteClient(async () => {
    const req = new Pipe();
    const res = new Pipe();
    void server.handle(req.in_, res.out, PEER);
    return [req.out, res.in_];
  });
  return { st, ev, services, server, client, store };
}

describe("Encoding compatibility (byte-identical to the device app's Wire.kt 0.2.26+)", () => {
  it("Text-only OFFER2: op=6, 0 items, 1 text, i32 length + UTF-8", () => {
    const b = encodeRequest({ kind: "offer", items: [], texts: ["hi"] });
    expect([...b]).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0x68, 0x69]);
  });

  it("OFFER2 with a file: (str relPath, i64 size, i64 mtime) followed by 0 texts", () => {
    const b = encodeRequest({ kind: "offer", items: [{ relPath: "a", size: 1, mtime: 2 }], texts: [] });
    expect([...b]).toEqual([6, 0, 0, 0, 1, 0, 1, 0x61, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("PAIR / PAIR_STATUS / UNPAIR / OFFER_STATUS", () => {
    expect([...encodeRequest({ kind: "pair", name: "X" })]).toEqual([7, 0, 1, 0x58]);
    expect([...encodeRequest({ kind: "pairStatus", token: "t" })]).toEqual([8, 0, 1, 0x74]);
    expect([...encodeRequest({ kind: "unpair", name: "X" })]).toEqual([9, 0, 1, 0x58]);
    expect([...encodeRequest({ kind: "offerStatus", token: "t" })]).toEqual([4, 0, 1, 0x74]);
  });

  it("Offer response: OK, str token, u8 status", () => {
    expect([...encodeOfferResponse({ token: "t", status: OFFER_PENDING })]).toEqual([0, 0, 1, 0x74, 0]);
  });

  it("Cuts device names to 64 characters", () => {
    const b = encodeRequest({ kind: "pair", name: "€".repeat(70) });
    // u16 length = 64 chars × 3 bytes
    expect((b[1] << 8) | b[2]).toBe(64 * 3);
  });

  it("Sends texts longer than 64 KiB (i32 length)", async () => {
    const long = "x".repeat(200_000);
    const { client, ev } = setup({ [PEER]: "Pixel" });
    expect(await sendText(client, long)).toBe("accepted");
    expect(ev.texts[0].texts[0].length).toBe(200_000);
  });
});

describe("Receiving text (device → browser)", () => {
  it("Returns ACCEPTED on receipt and passes the text to the UI", async () => {
    const { client, ev } = setup({ [PEER]: "Pixel" });
    const r = await client.offer([], ["Grüße\nLine 2", "Ünïcödé"]);
    expect(r.status).toBe(OFFER_ACCEPTED);
    expect(ev.texts).toHaveLength(1);
    expect(ev.texts[0].peerName).toBe("Pixel");
    expect(ev.texts[0].texts).toEqual(["Grüße\nLine 2", "Ünïcödé"]);
    // ACCEPTED when the sender asks for the status too
    expect((await client.offerStatus(r.token)).status).toBe(OFFER_ACCEPTED);
  });

  it("An offer with files is PENDING and asks first; texts are held until accepted", async () => {
    const { client, ev, services } = setup({ [PEER]: "Pixel" });
    const r = await client.offer([{ relPath: "a.jpg", size: 3, mtime: 0 }], ["t"]);
    expect(r.status).toBe(OFFER_PENDING);
    expect(ev.fileOffers).toHaveLength(1);
    expect(ev.fileOffers[0].totalBytes).toBe(3);
    expect(ev.texts).toHaveLength(0);
    services.decideFiles(r.token, true);
    expect((await client.offerStatus(r.token)).status).toBe(OFFER_ACCEPTED);
    expect(ev.texts[0].texts).toEqual(["t"]);
    expect(ev.fileResolved).toEqual([r.token]);
  });

  it("Unknown peers get not paired (the device app's cue to request pairing automatically)", async () => {
    const { client, ev } = setup({});
    await expect(client.offer([], ["t"])).rejects.toThrow(new RemoteError(ERR_NOT_PAIRED));
    await expect(client.ping("Pixel")).rejects.toThrow(ERR_NOT_PAIRED);
    expect(ev.texts).toHaveLength(0);
  });

  it("Asking about an unknown token is an error", async () => {
    const { client } = setup({ [PEER]: "Pixel" });
    await expect(client.offerStatus("nope")).rejects.toThrow("unknown token");
  });
});

describe("Pairing request (device → browser)", () => {
  it("PENDING if not paired; allowing it saves the peer and gives ACCEPTED", async () => {
    const { client, ev, services, st } = setup({});
    const r = await client.pair("REDMAGIC");
    expect(r.status).toBe(OFFER_PENDING);
    expect(ev.pairs[0].name).toBe("REDMAGIC");
    // Only one prompt even if the request is resent automatically
    expect((await client.pair("REDMAGIC")).token).toBe(r.token);
    expect(ev.pairs).toHaveLength(1);

    services.decide(r.token, true);
    expect((await client.pairStatus(r.token)).status).toBe(OFFER_ACCEPTED);
    expect(st.isPaired(PEER)).toBe(true);
    expect(st.peerName(PEER)).toBe("REDMAGIC");
    expect(ev.resolved).toEqual([r.token]);
  });

  it("Cancel gives REJECTED and saves nothing", async () => {
    const { client, services, st } = setup({});
    const r = await client.pair("F-51F");
    services.decide(r.token, false);
    expect((await client.pairStatus(r.token)).status).toBe(OFFER_REJECTED);
    expect(st.isPaired(PEER)).toBe(false);
  });

  it("REJECTED on timeout", async () => {
    const { client, ev } = setup({}, 30);
    const r = await client.pair("F-51F");
    await new Promise((res) => setTimeout(res, 60));
    expect((await client.pairStatus(r.token)).status).toBe(OFFER_REJECTED);
    expect(ev.resolved).toEqual([r.token]);
  });

  it("Already paired gives ACCEPTED at once (no prompt)", async () => {
    const { client, ev } = setup({ [PEER]: "old" });
    expect((await client.pair("Pixel")).status).toBe(OFFER_ACCEPTED);
    expect(ev.pairs).toHaveLength(0);
  });
});

describe("Unpairing (device → browser)", () => {
  it("If paired, removes the peer, notifies, and returns OK", async () => {
    const { server, st, ev } = setup({ [PEER]: "Pixel" });
    const req = new Pipe();
    const res = new Pipe();
    await req.out.write(encodeRequest({ kind: "unpair", name: "Pixel" }));
    await req.out.finish();
    await server.handle(req.in_, res.out, PEER);
    expect((await res.in_.readExact(1))[0]).toBe(0);
    expect(st.isPaired(PEER)).toBe(false);
    expect(ev.unpaired).toEqual(["Pixel"]);
  });

  it("OK even if not paired (so the other side clears its record)", async () => {
    const { server, ev } = setup({});
    const req = new Pipe();
    const res = new Pipe();
    await req.out.write(encodeRequest({ kind: "unpair", name: "Pixel" }));
    await req.out.finish();
    await server.handle(req.in_, res.out, PEER);
    expect((await res.in_.readExact(1))[0]).toBe(0);
    expect(ev.unpaired).toHaveLength(0);
  });
});

describe("Sending side (browser → device)", () => {
  it("Polls while PENDING; accepted once the peer allows it", async () => {
    // Peer (playing the device app): ACCEPTED on the second poll
    let polls = 0;
    const d = await waitDecision(
      { token: "t", status: OFFER_PENDING },
      async (token) => ({ token, status: ++polls >= 2 ? OFFER_ACCEPTED : OFFER_PENDING }),
      { intervalMs: 1 },
    );
    expect(d).toBe("accepted");
    expect(polls).toBe(2);
  });

  it("Rejected and timed out", async () => {
    expect(
      await waitDecision({ token: "t", status: OFFER_PENDING }, async (token) => ({ token, status: OFFER_REJECTED }), {
        intervalMs: 1,
      }),
    ).toBe("rejected");
    expect(
      await waitDecision({ token: "t", status: OFFER_PENDING }, async (token) => ({ token, status: OFFER_PENDING }), {
        intervalMs: 1,
        timeoutMs: 20,
      }),
    ).toBe("timeout");
  });

  it("Cancel stops waiting", async () => {
    const ac = new AbortController();
    const p = waitDecision(
      { token: "t", status: OFFER_PENDING },
      async (token) => ({ token, status: OFFER_PENDING }),
      { intervalMs: 50, signal: ac.signal },
    );
    ac.abort();
    await expect(p).rejects.toThrow("Cancelled");
  });

  it("Request, peer allows, then sending text works", async () => {
    const { client, services, ev } = setup({});
    const pairing = requestPair(client, "Brówser (Windows)", { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 10));
    services.decide(ev.pairs[0].token, true);
    expect(await pairing).toBe("accepted");
    expect(await sendText(client, "Got it? 👍")).toBe("accepted");
    expect(ev.texts[0].texts).toEqual(["Got it? 👍"]);
  });

  it("Out-of-range status in the response is a protocol error", async () => {
    const res = new Pipe();
    await res.out.write(Uint8Array.of(0, 0, 1, 0x74, 9));
    await res.out.finish();
    await expect(readOfferResponse(new Decoder(res.in_))).rejects.toThrow("bad offer status");
  });
});

/**
 * Minimal copy of the device app's receiving side (Incoming.kt): the offer is accepted on the first status query,
 * PUT returns the byte count it already has, receives the rest, and returns OK at the end.
 */
class FakeDevice {
  received = new Map<string, Uint8Array>();
  offered: { relPath: string; size: number; mtime: number }[] = [];
  texts: string[] = [];
  status = OFFER_PENDING;
  /** Status returned from the second query on. */
  decide = OFFER_ACCEPTED;
  /** relPath whose PUT is made to fail. */
  failOn = "";

  client() {
    return new RemoteClient(async () => {
      const req = new Pipe();
      const res = new Pipe();
      void this.handle(req.in_, res.out);
      return [req.out, res.in_];
    });
  }

  private async handle(input: FrameIn, output: FrameOut) {
    const d = new Decoder(input);
    const r = await decodeRequest(d);
    if (r.kind === "offer") {
      this.offered = r.items;
      this.texts = r.texts;
      await output.write(encodeOfferResponse({ token: "tk", status: this.status }));
    } else if (r.kind === "offerStatus") {
      this.status = this.decide;
      await output.write(encodeOfferResponse({ token: r.token, status: this.status }));
    } else if (r.kind === "put") {
      if (r.token !== "tk" || this.status !== OFFER_ACCEPTED) {
        await output.write(encodeError("not accepted"));
      } else {
        const have = this.received.get(r.relPath) ?? new Uint8Array(0);
        await output.write(new Encoder().u8(0).i64(have.length).bytes());
        let body: Uint8Array;
        try {
          body = await input.readExact(r.size - have.length);
        } catch {
          return; // The sender aborted (simplified: partial data is not kept)
        }
        const all = new Uint8Array(r.size);
        all.set(have);
        all.set(body, have.length);
        if (r.relPath === this.failOn) {
          await output.write(encodeError("disk full"));
        } else {
          this.received.set(r.relPath, all);
          await output.write(encodeOk());
        }
      }
    }
    await output.finish();
  }
}

function memFile(relPath: string, data: Uint8Array, reads?: number[]): SendFile {
  return {
    item: { relPath, size: data.length, mtime: 1700000000000 },
    read: async (pos, len) => {
      reads?.push(pos);
      return data.subarray(pos, pos + len);
    },
  };
}

function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

describe("Sending files (browser → device)", () => {
  it("PUT request bytes: op=5, str token, str relPath, i64 size, i64 mtime", () => {
    const b = encodeRequest({ kind: "put", token: "t", relPath: "a", size: 2, mtime: 3 });
    expect([...b]).toEqual([5, 0, 1, 0x74, 0, 1, 0x61, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3]);
  });

  it("Lists files in the offer and sends all after acceptance (folders, 0 bytes, larger than CHUNK)", async () => {
    const dev = new FakeDevice();
    const big = bytes(256 * 1024 * 2 + 123);
    const files = [
      memFile("Café/IMG_0001.jpg", bytes(1000)),
      memFile("Café/sub/vacío.txt", new Uint8Array(0)),
      memFile("big.bin", big),
    ];
    const progress: number[] = [];
    const d = await sendFiles(dev.client(), files, [], {
      intervalMs: 1,
      onProgress: (p) => progress.push(p.done),
    });
    expect(d).toBe("accepted");
    expect(dev.offered.map((x) => x.relPath)).toEqual(["Café/IMG_0001.jpg", "Café/sub/vacío.txt", "big.bin"]);
    expect(dev.offered[2].size).toBe(big.length);
    expect(dev.received.get("Café/IMG_0001.jpg")).toEqual(bytes(1000));
    expect(dev.received.get("Café/sub/vacío.txt")?.length).toBe(0);
    expect(dev.received.get("big.bin")).toEqual(big);
    expect(progress.at(-1)).toBe(1000 + big.length);
  });

  it("Skips what the peer already has and sends the rest (resume)", async () => {
    const dev = new FakeDevice();
    const data = bytes(5000);
    dev.received.set("a.bin", data.slice(0, 3000));
    const reads: number[] = [];
    await sendFiles(dev.client(), [memFile("a.bin", data, reads)], [], { intervalMs: 1 });
    expect(reads[0]).toBe(3000);
    expect(dev.received.get("a.bin")).toEqual(data);
  });

  it("Sends nothing when rejected", async () => {
    const dev = new FakeDevice();
    dev.decide = OFFER_REJECTED;
    const d = await sendFiles(dev.client(), [memFile("a.bin", bytes(10))], [], { intervalMs: 1 });
    expect(d).toBe("rejected");
    expect(dev.received.size).toBe(0);
  });

  it("A save failure on the peer (ERR trailer) throws and stops further sends", async () => {
    const dev = new FakeDevice();
    dev.failOn = "1.bin";
    await expect(
      sendFiles(dev.client(), [memFile("1.bin", bytes(10)), memFile("2.bin", bytes(10))], [], { intervalMs: 1 }),
    ).rejects.toThrow("disk full");
    expect(dev.received.has("2.bin")).toBe(false);
  });

  it("Cancel while sending", async () => {
    const dev = new FakeDevice();
    const ac = new AbortController();
    const data = bytes(256 * 1024 * 3);
    const f: SendFile = {
      item: { relPath: "c.bin", size: data.length, mtime: 0 },
      read: async (pos, len) => {
        if (pos > 0) ac.abort(); // Stop when the second chunk is read
        return data.subarray(pos, pos + len);
      },
    };
    await expect(sendFiles(dev.client(), [f], [], { intervalMs: 1, signal: ac.signal })).rejects.toThrow(
      CancelledError,
    );
    expect(dev.received.has("c.bin")).toBe(false);
  });

  it("Sends files and texts in one offer", async () => {
    const dev = new FakeDevice();
    await sendFiles(dev.client(), [memFile("a.txt", bytes(3))], ["Mémo"], { intervalMs: 1 });
    expect(dev.texts).toEqual(["Mémo"]);
    expect(dev.received.has("a.txt")).toBe(true);
  });

});

describe("Receiving files (device or browser → this browser)", () => {
  it("Receives files one by one after acceptance (folders, 0 bytes, larger than CHUNK) and reports progress and completion to the UI", async () => {
    const { client, ev, store } = setup({ [PEER]: "Pixel" }, 120_000, [], true);
    const big = bytes(256 * 1024 * 2 + 123);
    const files = [
      memFile("Café/IMG_0001.jpg", bytes(1000)),
      memFile("Café/sub/vacío.txt", new Uint8Array(0)),
      memFile("big.bin", big),
    ];
    const d = await sendFiles(client, files, [], { intervalMs: 1 });
    expect(d).toBe("accepted");
    expect(store.files.get("Café/IMG_0001.jpg")).toEqual(bytes(1000));
    expect(store.files.get("Café/sub/vacío.txt")?.length).toBe(0);
    expect(store.files.get("big.bin")).toEqual(big);
    expect(ev.done).toHaveLength(1);
    expect(ev.done[0]).toMatchObject({ done: 1000 + big.length, total: 1000 + big.length, files: 3 });
    expect(ev.progress.length).toBeGreaterThan(3);
    expect(ev.failed).toHaveLength(0);
  });

  it("Receives nothing when rejected", async () => {
    const { client, ev, store } = setup({ [PEER]: "Pixel" }, 120_000, [], false);
    const d = await sendFiles(client, [memFile("a.bin", bytes(10))], [], { intervalMs: 1 });
    expect(d).toBe("rejected");
    expect(store.files.size).toBe(0);
    expect(ev.done).toHaveLength(0);
  });

  it("REJECTED on timeout with no answer", async () => {
    const { client, ev } = setup({ [PEER]: "Pixel" }, 5);
    const r = await client.offer([{ relPath: "a.bin", size: 1, mtime: 0 }], []);
    await new Promise((res) => setTimeout(res, 20));
    expect((await client.offerStatus(r.token)).status).toBe(OFFER_REJECTED);
    expect(ev.fileResolved).toEqual([r.token]);
  });

  it("Refuses PUT when not accepted, not in the offer, wrong size, or unknown token", async () => {
    const { client, services } = setup({ [PEER]: "Pixel" });
    const r = await client.offer([{ relPath: "a.bin", size: 3, mtime: 0 }], []);
    await expect(client.put(r.token, { relPath: "a.bin", size: 3, mtime: 0 })).rejects.toThrow("not accepted");
    services.decideFiles(r.token, true);
    await expect(client.put(r.token, { relPath: "b.bin", size: 3, mtime: 0 })).rejects.toThrow("not in offer");
    await expect(client.put(r.token, { relPath: "a.bin", size: 4, mtime: 0 })).rejects.toThrow("not in offer");
    await expect(client.put("nope", { relPath: "a.bin", size: 3, mtime: 0 })).rejects.toThrow("unknown token");
  });

  it("Skips what the sink already has and receives the rest (resume)", async () => {
    const { client, store } = setup({ [PEER]: "Pixel" }, 120_000, [], true);
    const data = bytes(5000);
    store.files.set("a.bin", data.slice(0, 3000));
    const reads: number[] = [];
    await sendFiles(client, [memFile("a.bin", data, reads)], [], { intervalMs: 1 });
    expect(reads[0]).toBe(3000);
    expect(store.files.get("a.bin")).toEqual(data);
  });

  it("Cancelling here gives the sender an error with the reason and refuses later files", async () => {
    const { client, ev, services, store } = setup({ [PEER]: "Pixel" }, 120_000, [], true);
    const data = bytes(256 * 1024 * 3);
    const f: SendFile = {
      item: { relPath: "c.bin", size: data.length, mtime: 0 },
      read: async (pos, len) => {
        if (pos > 0) services.cancelReceive(ev.fileOffers[0].token); // The receiver stops before the second chunk is sent
        return data.subarray(pos, pos + len);
      },
    };
    await expect(sendFiles(client, [f, memFile("d.bin", bytes(3))], [], { intervalMs: 1 })).rejects.toThrow(
      ERR_RECEIVE_CANCELLED,
    );
    expect(ev.failed).toEqual([{ relPath: "c.bin", reason: ERR_RECEIVE_CANCELLED }]);
    expect(store.aborted.map((x) => x.relPath)).toEqual(["c.bin"]);
    expect(store.files.has("d.bin")).toBe(false);
    expect(ev.done).toHaveLength(0);
  });

  it("If the sender stops midway, aborts the sink and reports the failure to the UI", async () => {
    const { client, ev, store } = setup({ [PEER]: "Pixel" }, 120_000, [], true);
    const ac = new AbortController();
    const data = bytes(256 * 1024 * 3);
    const f: SendFile = {
      item: { relPath: "e.bin", size: data.length, mtime: 0 },
      read: async (pos, len) => {
        if (pos > 0) ac.abort();
        return data.subarray(pos, pos + len);
      },
    };
    await expect(sendFiles(client, [f], [], { intervalMs: 1, signal: ac.signal })).rejects.toThrow(CancelledError);
    await new Promise((res) => setTimeout(res, 10));
    expect(store.aborted.map((x) => x.relPath)).toEqual(["e.bin"]);
    expect(ev.failed.map((x) => x.relPath)).toEqual(["e.bin"]);
    expect(ev.done).toHaveLength(0);
  });

  it("A sink write failure is returned to the sender with the reason", async () => {
    const { client, store } = setup({ [PEER]: "Pixel" }, 120_000, [], true);
    store.sink = () => ({
      offset: async () => 0,
      start: async () => {},
      write: async () => {
        throw new Error("Not enough space");
      },
      commit: async () => "",
      abort: async () => {},
    });
    await expect(sendFiles(client, [memFile("a.bin", bytes(10))], [], { intervalMs: 1 })).rejects.toThrow(
      "Not enough space",
    );
  });

  it("A file offer from an unknown peer gets not paired", async () => {
    const { client, ev } = setup({});
    await expect(client.offer([{ relPath: "a", size: 1, mtime: 0 }], [])).rejects.toThrow(ERR_NOT_PAIRED);
    expect(ev.fileOffers).toHaveLength(0);
  });
});

describe("Unpairing (browser → device) and the unpaired record", () => {
  it("UNPAIR request bytes, and OK once it reaches the peer", async () => {
    // The browser server plays the device app (same endpoint)
    const { client, st, ev } = setup({ [PEER]: "Pixel" });
    await notifyUnpair(client, "Brówser");
    expect(st.isPaired(PEER)).toBe(false);
    expect(ev.unpaired).toEqual(["Pixel"]);
  });

  it("Returns unpaired to normal requests from peers this side unpaired (PAIR still works)", async () => {
    const { client } = setup({}, 120_000, [PEER]);
    await expect(client.ping("Pixel")).rejects.toThrow(new RemoteError(ERR_UNPAIRED));
    await expect(client.offer([], ["t"])).rejects.toThrow(ERR_UNPAIRED);
    expect((await client.pair("Pixel")).status).toBe(OFFER_PENDING);
  });

  it("Allowing an unpaired peer again clears the record and things work normally", async () => {
    const { client, services, st } = setup({}, 120_000, [PEER]);
    const r = await client.pair("Pixel");
    services.decide(r.token, true);
    expect(st.isUnpaired(PEER)).toBe(false);
    expect(await sendText(client, "Zurück 👋")).toBe("accepted");
  });

  it("An UNPAIR from the peer also clears the record (both sides unpaired)", async () => {
    const { client, st } = setup({}, 120_000, [PEER]);
    await notifyUnpair(client, "Pixel");
    expect(st.isUnpaired(PEER)).toBe(false);
  });

  it("Throws on timeout when there is no response", async () => {
    const silent = new RemoteClient(async () => {
      const req = new Pipe();
      const res = new Pipe();
      return [req.out, res.in_]; // Nobody responds
    });
    await expect(notifyUnpair(silent, "Brówser", 20)).rejects.toThrow("No response");
  });
});

describe("Reconnecting", () => {
  it("On a transport error, reconnects and retries once", async () => {
    const { server } = setup({ [PEER]: "Pixel" });
    let opens = 0;
    let lost = 0;
    const client = new RemoteClient(
      async () => {
        opens++;
        const req = new Pipe();
        const res = new Pipe();
        if (opens === 1) {
          // First attempt: the peer restarted and never answers (reading hits a disconnect)
          await res.out.abort();
        } else {
          void server.handle(req.in_, res.out, PEER);
        }
        return [req.out, res.in_];
      },
      () => lost++,
    );
    expect(await sendText(client, "Après redémarrage")).toBe("accepted");
    expect(lost).toBe(1);
    expect(opens).toBe(2);
  });

  it("Does not retry on an ERR response from the peer", async () => {
    const { server } = setup({});
    let lost = 0;
    const client = new RemoteClient(async () => {
      const req = new Pipe();
      const res = new Pipe();
      void server.handle(req.in_, res.out, PEER);
      return [req.out, res.in_];
    }, () => lost++);
    await expect(client.ping("Pixel")).rejects.toThrow(ERR_NOT_PAIRED);
    expect(lost).toBe(0);
  });
});

describe("PING (presence check, like the app 0.2.36)", () => {
  it("returns this browser's name and takes the other device's current name", async () => {
    const { client, st, ev } = setup({ [PEER]: "Pixel" });
    expect(await client.ping("Pixel 9 Pro XL")).toBe("Chrome (Android)");
    expect(st.peers.get(PEER)).toBe("Pixel 9 Pro XL");
    // a PING isn't a pairing event, but tells the UI the device is online
    expect(ev.logs).toEqual([]);
    expect(ev.pings).toEqual([PEER]);
  });

  it("cuts long names to 64 characters both ways", async () => {
    const { client, st } = setup({ [PEER]: "Pixel" });
    await client.ping("y".repeat(70));
    expect(st.peers.get(PEER)).toBe("y".repeat(64));
  });

  it("a blank name keeps the saved one", async () => {
    const { client, st } = setup({ [PEER]: "Pixel" });
    await client.ping("  ");
    expect(st.peers.get(PEER)).toBe("Pixel");
  });

  it("unpaired devices get not paired, and devices this browser unpaired get unpaired", async () => {
    await expect(setup({}).client.ping("x")).rejects.toThrow(new RemoteError(ERR_NOT_PAIRED));
    await expect(setup({}, 120_000, [PEER]).client.ping("x")).rejects.toThrow(new RemoteError(ERR_UNPAIRED));
  });
});

describe("pairing history entries", () => {
  it("request received, then allowed", async () => {
    const { client, services, ev } = setup({});
    const r = await client.pair("REDMAGIC");
    services.decide(r.token, true);
    expect(ev.logs).toEqual(["requestReceived", "receivedAccepted"]);
  });

  it("request received, then cancelled or timed out", async () => {
    const a = setup({});
    a.services.decide((await a.client.pair("A")).token, false);
    expect(a.ev.logs).toEqual(["requestReceived", "receivedRejected"]);
    const b = setup({}, 10);
    await b.client.pair("B");
    await new Promise((r) => setTimeout(r, 30));
    expect(b.ev.logs).toEqual(["requestReceived", "receivedTimedOut"]);
  });

  it("unpaired by the other device", async () => {
    const { client, ev } = setup({ [PEER]: "Pixel" });
    await notifyUnpair(client, "Pixel");
    expect(ev.logs).toEqual(["unpairedByPeer"]);
  });
});
