import { afterEach, describe, expect, it, vi } from "vitest";
import { Presence, PING_TIMEOUT_MS } from "./presence";
import { ERR_NOT_PAIRED, ERR_UNPAIRED, RemoteError } from "../proto/wire";
import type { RemoteClient } from "../proto/remoteClient";
import type { Peer, Settings } from "./settings";

const A = "a".repeat(64);

/** Presence with fake settings and a ping that follows `answer`. */
function make(answer: (attempt: number) => Promise<string>) {
  const peers: Peer[] = [{ id: A, name: "Pixel" }];
  let attempts = 0;
  const ev = { dropped: 0, unpaired: [] as string[], changes: 0 };
  let busy = false;
  const settings = {
    get peers() {
      return [...peers];
    },
    deviceName: "Chrome (Android)",
    isPaired: (id: string) => peers.some((p) => p.id === id),
    renamePeer: (id: string, name: string) => {
      const p = peers.find((x) => x.id === id);
      if (!p || p.name === name) return false;
      p.name = name;
      return true;
    },
  } as unknown as Settings;
  const presence = new Presence({
    settings,
    client: () => ({ ping: () => answer(++attempts) }) as unknown as RemoteClient,
    dropConnection: () => ev.dropped++,
    transferring: () => busy,
    pathSummary: () => "relay|85",
    onUnpaired: (p) => {
      ev.unpaired.push(p.name);
      peers.splice(0, 1);
    },
    onChange: () => ev.changes++,
    log: () => {},
  });
  return { presence, peers, ev, attempts: () => attempts, setBusy: (b: boolean) => (busy = b) };
}

afterEach(() => vi.useRealTimers());

describe("Presence", () => {
  it("starts as checking; an answer means online with the route, and renames the device", async () => {
    const { presence, peers } = make(async () => "Pixel 9 Pro XL");
    expect(presence.get(A)).toEqual({ kind: "checking" });
    await presence.checkAll();
    expect(presence.get(A)).toEqual({ kind: "online", route: "Relay 85ms" });
    expect(peers[0].name).toBe("Pixel 9 Pro XL");
  });

  it("not paired -> online but the other device hasn't added this one", async () => {
    const { presence } = make(async () => {
      throw new RemoteError(ERR_NOT_PAIRED);
    });
    await presence.checkAll();
    expect(presence.get(A).kind).toBe("notPairedThere");
  });

  it("unpaired -> removed here too, and the state is forgotten", async () => {
    const { presence, ev } = make(async () => {
      throw new RemoteError(ERR_UNPAIRED);
    });
    await presence.checkAll();
    expect(ev.unpaired).toEqual(["Pixel"]);
    expect(presence.get(A).kind).toBe("checking");
  });

  it("other errors from the device (e.g. unknown op from an old version) count as online", async () => {
    const { presence } = make(async () => {
      throw new RemoteError("bad request: unknown op 10");
    });
    await presence.checkAll();
    expect(presence.get(A).kind).toBe("online");
  });

  it("a connect failure is offline and drops the connection", async () => {
    const { presence, ev } = make(async () => {
      throw new Error("connect: no route");
    });
    await presence.checkAll();
    expect(presence.get(A).kind).toBe("offline");
    expect(ev.dropped).toBe(1);
  });

  it("no answer: drops the connection, tries once more, then offline", async () => {
    vi.useFakeTimers();
    const { presence, ev, attempts } = make(() => new Promise<string>(() => {}));
    const p = presence.checkAll();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS * 2 + 10);
    await p;
    expect(attempts()).toBe(2);
    expect(ev.dropped).toBe(2);
    expect(presence.get(A).kind).toBe("offline");
  });

  it("a PING from a paired device marks it online at once (e.g. right after pairing)", async () => {
    const { presence } = make(async () => {
      throw new RemoteError(ERR_NOT_PAIRED);
    });
    await presence.checkAll();
    expect(presence.get(A).kind).toBe("notPairedThere");
    presence.heardFrom(A);
    expect(presence.get(A)).toEqual({ kind: "online", route: "Relay 85ms" });
    presence.heardFrom("c".repeat(64)); // not paired: ignored
    expect(presence.get("c".repeat(64)).kind).toBe("checking");
  });

  it("a device with a running transfer is online and isn't pinged (a ping timeout would cut the transfer)", async () => {
    const { presence, attempts, ev, setBusy } = make(() => new Promise<string>(() => {}));
    setBusy(true);
    await presence.checkAll();
    expect(attempts()).toBe(0);
    expect(ev.dropped).toBe(0);
    expect(presence.get(A).kind).toBe("online");
  });

  it("a stale connection: the retry on a new one answers -> online", async () => {
    vi.useFakeTimers();
    const { presence, attempts } = make((n) => (n === 1 ? new Promise<string>(() => {}) : Promise.resolve("Pixel")));
    const p = presence.checkAll();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS + 10);
    await p;
    expect(attempts()).toBe(2);
    expect(presence.get(A).kind).toBe("online");
  });
});
