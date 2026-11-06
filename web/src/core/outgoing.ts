/**
 * Offers from this browser (sending text and files) and pairing requests.
 * Same steps as the app's data/Transfers.kt (sending) and data/Pairing.kt (requests):
 *   offer -> while PENDING, ask for the state every second -> ACCEPTED / REJECTED / timeout.
 *   Files are sent one by one with PUT after acceptance (continuing from what the other device has).
 */
import type { PutSession, RemoteClient } from "../proto/remoteClient";
import type { OfferItem, OfferResponse } from "../proto/wire";
import { CHUNK, OFFER_ACCEPTED, OFFER_PENDING, OFFER_REJECTED } from "../proto/wire";
import { CONSENT_TIMEOUT_MS } from "./peerServices";

/** How long the sender waits: a little longer than the other device's consent timeout (120 s). */
export const SENDER_TIMEOUT_MS = CONSENT_TIMEOUT_MS + 5_000;
export const POLL_INTERVAL_MS = 1_000;

export type Decision = "accepted" | "rejected" | "timeout";

export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "AbortError";
  }
}

/** Polls while PENDING and returns the result. */
export async function waitDecision(
  first: OfferResponse,
  poll: (token: string) => Promise<OfferResponse>,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onPending?: () => void } = {},
): Promise<Decision> {
  const timeoutMs = opts.timeoutMs ?? SENDER_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let r = first;
  if (r.status === OFFER_PENDING) opts.onPending?.();
  while (r.status === OFFER_PENDING && Date.now() < deadline) {
    if (opts.signal?.aborted) throw new CancelledError();
    await sleep(intervalMs, opts.signal);
    r = await poll(r.token);
  }
  if (r.status === OFFER_ACCEPTED) return "accepted";
  if (r.status === OFFER_REJECTED) return "rejected";
  return "timeout";
}

/** One file to send. read returns len bytes from pos (File.slice in the browser). */
export interface SendFile {
  item: OfferItem;
  read(pos: number, len: number): Promise<Uint8Array>;
}

export interface SendProgress {
  /** Bytes sent in total (including what the other device already had). */
  done: number;
  total: number;
  /** relPath of the file being sent. */
  current: string;
  /** Files finished. */
  files: number;
}

/**
 * Sends files (and texts). If the other device doesn't accept, returns "rejected" / "timeout" and sends nothing.
 * Throws on failure or cancel midway (the other device keeps partial data, so sending the same again resumes).
 */
export async function sendFiles(
  client: RemoteClient,
  files: SendFile[],
  texts: string[],
  opts: {
    signal?: AbortSignal;
    onPending?: () => void;
    onAccepted?: () => void;
    onProgress?: (p: SendProgress) => void;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<Decision> {
  const first = await client.offer(
    files.map((f) => f.item),
    texts,
  );
  const decision = await waitDecision(first, (t) => client.offerStatus(t), opts);
  if (decision !== "accepted") return decision;
  opts.onAccepted?.();

  const total = files.reduce((a, f) => a + f.item.size, 0);
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (opts.signal?.aborted) throw new CancelledError();
    const put: PutSession = await client.put(first.token, f.item);
    try {
      let pos = put.offset;
      done += pos; // what the other device already has
      opts.onProgress?.({ done, total, current: f.item.relPath, files: i });
      while (pos < f.item.size) {
        if (opts.signal?.aborted) throw new CancelledError();
        const chunk = await f.read(pos, Math.min(CHUNK, f.item.size - pos));
        if (chunk.length === 0) throw new Error(`Couldn't read ${f.item.relPath} (it may have changed while sending).`);
        await put.write(chunk);
        pos += chunk.length;
        done += chunk.length;
        opts.onProgress?.({ done, total, current: f.item.relPath, files: i });
      }
      await put.finish();
    } catch (e) {
      await put.abort();
      throw e;
    }
    opts.onProgress?.({ done, total, current: f.item.relPath, files: i + 1 });
  }
  return "accepted";
}

/** Sends text (OFFER2 with no files). */
export function sendText(
  client: RemoteClient,
  text: string,
  opts: { signal?: AbortSignal; onPending?: () => void; timeoutMs?: number; intervalMs?: number } = {},
): Promise<Decision> {
  return sendFiles(client, [], [text], opts);
}

/** Requests pairing. myName is shown in the other device's dialog and saved there. */
export async function requestPair(
  client: RemoteClient,
  myName: string,
  opts: { signal?: AbortSignal; onPending?: () => void; timeoutMs?: number; intervalMs?: number } = {},
): Promise<Decision> {
  const first = await client.pair(myName);
  return await waitDecision(first, (t) => client.pairStatus(t), opts);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Limit for the unpair notice (if the other device is offline it can't connect, so don't wait long). */
export const UNPAIR_TIMEOUT_MS = 20_000;

/**
 * Tells the other device about an unpair. If it arrives, the other device removes this browser without asking.
 * Throws if it didn't arrive (the caller keeps an "unpaired" record and answers the device's next request with "unpaired").
 */
export async function notifyUnpair(client: RemoteClient, myName: string, timeoutMs = UNPAIR_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("No response from the other device.")), timeoutMs);
  });
  try {
    await Promise.race([client.unpair(myName), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
