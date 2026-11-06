/** QR codes: generating (qrcode) and scanning (BarcodeDetector if available, otherwise jsQR). */
import QRCode from "qrcode";
import jsQR from "jsqr";

export async function qrToCanvas(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await QRCode.toCanvas(canvas, text, { width: 220, margin: 1 });
}

export interface QrScanner {
  stop(): void;
}

/**
 * Scans a QR code with the camera. Calls onResult and stops when one is found.
 * Throws if the camera can't start (e.g. permission denied).
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (msg: string) => void,
): Promise<QrScanner> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  const detector =
    "BarcodeDetector" in window
      ? new (window as any).BarcodeDetector({ formats: ["qr_code"] })
      : null;
  const canvas = document.createElement("canvas");

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        let text: string | null = null;
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length > 0) text = codes[0].rawValue as string;
        } else {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) text = code.data;
        }
        if (text) {
          stop();
          onResult(text);
          return;
        }
      }
    } catch (e) {
      stop();
      onError(e instanceof Error ? e.message : String(e));
      return;
    }
    setTimeout(tick, 150);
  };
  void tick();

  return { stop };
}
