/**
 * Settings (localStorage). The key is fixed per browser (shared between tabs).
 * Like the app's Settings: secret key, device name, paired devices, relay URL, devices unpaired by this browser.
 */
import { id_from_secret, secret_generate } from "../wasm/peersync_wasm";
import { MAX_NAME_CHARS } from "../proto/wire";
import { browserKind } from "./browserKind";

const KEY = "peersync.settings.v1";

export interface Peer {
  id: string;
  name: string;
}

interface Stored {
  secretHex: string;
  /** Name set in Settings > Device name. Empty = the default (browser and OS, see defaultDeviceName). */
  name: string;
  peers: Peer[];
  relayUrl: string;
  /** Device IDs (lower case) this browser unpaired whose notice hasn't reached them yet. */
  unpaired: string[];
}

/**
 * Default names saved by versions up to 2026-11-05 (the Japanese word for "browser", alone or with " (Android)" etc.).
 * They were never typed by the user, so they count as "not set" and the new default is used.
 */
const OLD_DEFAULT_NAME = /^\u30d6\u30e9\u30a6\u30b6( \((Android|iOS|Windows|Mac)\))?$/;

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Stored;
      if (typeof s.secretHex === "string" && /^[0-9a-fA-F]{64}$/.test(s.secretHex)) {
        const name = typeof s.name === "string" ? s.name : "";
        return {
          secretHex: s.secretHex,
          name: OLD_DEFAULT_NAME.test(name) ? "" : name,
          peers: Array.isArray(s.peers) ? s.peers.filter((p) => isValidId(p?.id)) : [],
          relayUrl: typeof s.relayUrl === "string" ? s.relayUrl : "",
          unpaired: Array.isArray(s.unpaired) ? s.unpaired.filter((x) => isValidId(x)) : [],
        };
      }
    }
  } catch {
    // broken: start over
  }
  return { secretHex: secret_generate(), name: "", peers: [], relayUrl: "", unpaired: [] };
}

/** An iroh device ID is a 32-byte public key as 64 hex characters. */
export function isValidId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-fA-F]{64}$/.test(id);
}

export class Settings {
  private s: Stored;
  onChange?: () => void;
  /** Default device name (the browser and OS). */
  readonly defaultDeviceName = browserKind();

  constructor() {
    this.s = load();
    this.save();
  }

  private save() {
    localStorage.setItem(KEY, JSON.stringify(this.s));
    this.onChange?.();
  }

  get secretHex(): string {
    return this.s.secretHex;
  }

  get nodeId(): string {
    return id_from_secret(this.s.secretHex);
  }

  /** The name set in Settings (empty = default). */
  get customName(): string {
    return this.s.name;
  }

  /** The name other devices see (set name, or the default). */
  get deviceName(): string {
    return this.s.name || this.defaultDeviceName;
  }

  /** Sets the device name. Empty = back to the default. */
  setDeviceName(v: string) {
    this.s.name = v.trim().slice(0, MAX_NAME_CHARS);
    this.save();
  }

  get relayUrl(): string {
    return this.s.relayUrl;
  }

  set relayUrl(v: string) {
    this.s.relayUrl = v.trim();
    this.save();
  }

  /** Copies (changing them doesn't change the settings; renamePeer etc. do). */
  get peers(): Peer[] {
    return this.s.peers.map((p) => ({ ...p }));
  }

  isPaired(id: string): boolean {
    const lower = id.toLowerCase();
    return this.s.peers.some((p) => p.id.toLowerCase() === lower);
  }

  peerName(id: string): string {
    const lower = id.toLowerCase();
    return this.s.peers.find((p) => p.id.toLowerCase() === lower)?.name ?? shortId(id);
  }

  addPeer(id: string, name?: string | null) {
    if (!isValidId(id)) throw new Error("Invalid device ID");
    const lower = id.toLowerCase();
    // paired again with a device we unpaired: treat it normally from now on (no "unpaired")
    this.s.unpaired = this.s.unpaired.filter((x) => x !== lower);
    const existing = this.s.peers.find((p) => p.id.toLowerCase() === lower);
    if (existing) {
      if (name) existing.name = name;
    } else {
      this.s.peers.push({ id, name: name || shortId(id) });
    }
    this.save();
  }

  /**
   * Keeps a paired device's name current (PING carries it). Returns true if it changed.
   * Blank names and unknown devices are ignored.
   */
  renamePeer(id: string, name: string): boolean {
    const n = name.trim().slice(0, MAX_NAME_CHARS);
    if (!n) return false;
    const lower = id.toLowerCase();
    const p = this.s.peers.find((x) => x.id.toLowerCase() === lower);
    if (!p || p.name === n) return false;
    p.name = n;
    this.save();
    return true;
  }

  /** Whether this browser unpaired the device ("unpaired" is returned until the notice arrives). */
  isUnpaired(id: string): boolean {
    return this.s.unpaired.includes(id.toLowerCase());
  }

  markUnpaired(id: string) {
    const lower = id.toLowerCase();
    if (!this.s.unpaired.includes(lower)) this.s.unpaired.push(lower);
    this.save();
  }

  /** Clears the record once the notice arrived or the device was paired again. */
  clearUnpaired(id: string) {
    const lower = id.toLowerCase();
    if (!this.s.unpaired.includes(lower)) return;
    this.s.unpaired = this.s.unpaired.filter((x) => x !== lower);
    this.save();
  }

  /**
   * New device ID (new secret key). Paired devices and unpaired records are cleared
   * (the other devices only know the old ID). The device name and relay are kept.
   */
  resetIdentity() {
    this.s.secretHex = secret_generate();
    this.s.peers = [];
    this.s.unpaired = [];
    this.save();
  }

  removePeer(id: string) {
    const lower = id.toLowerCase();
    this.s.peers = this.s.peers.filter((p) => p.id.toLowerCase() !== lower);
    this.save();
  }
}

/** First 10 characters of a device ID, as the app shows it ("<shortId>…"). */
export function shortId(id: string): string {
  return id.slice(0, 10);
}
