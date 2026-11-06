/**
 * Browser and OS from the user agent, used as the default device name (the app's default is the model name).
 * Kept separate from settings.ts so it can be tested without the wasm module.
 */

/** The browser and OS from the user agent, e.g. "Chrome (Android)", "Safari (iPad)". */
export function browserKind(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): string {
  const browser = detectBrowser(ua);
  const os = detectOs(ua, touchPoints);
  return os ? `${browser} (${os})` : browser;
}

function detectBrowser(ua: string): string {
  // order matters: Edge, Opera and Samsung Internet also say "Chrome"; Chrome also says "Safari"
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return "Edge";
  if (/OPR\/|OPT\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS/.test(ua)) return "Firefox";
  if (/CriOS|Chrome\/|Chromium\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

function detectOs(ua: string, touchPoints: number): string | null {
  if (/Android/.test(ua)) return "Android";
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  // iPadOS 13+ Safari reports itself as a Mac; a touch screen tells them apart
  if (/Macintosh/.test(ua)) return touchPoints > 1 ? "iPad" : "Mac";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}
