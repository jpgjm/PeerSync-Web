/** Pairing code: peersync:<device ID>?name=<device name>. Same as the apps. */
import { isValidId } from "./settings";

export function encodePairing(id: string, name: string): string {
  return `peersync:${id}?name=` + encodeURIComponent(name);
}

/** Gets (id, name) from a QR string or a pasted ID. null if invalid. */
export function decodePairing(text: string): { id: string; name: string | null } | null {
  text = text.trim();
  const body = text.toLowerCase().startsWith("peersync:")
    ? text.slice("peersync:".length)
    : text;

  let id: string;
  let name: string | null = null;
  const q = body.indexOf("?");
  if (q >= 0) {
    id = body.slice(0, q);
    for (const kv of body.slice(q + 1).split("&")) {
      const eq = kv.indexOf("=");
      if (eq > 0 && kv.slice(0, eq) === "name") {
        try {
          name = decodeURIComponent(kv.slice(eq + 1));
        } catch {
          name = kv.slice(eq + 1);
        }
      }
    }
  } else {
    id = body;
  }

  id = id.trim();
  return isValidId(id) ? { id, name } : null;
}
