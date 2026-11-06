/**
 * Sink for received files (DownloadSink): one file at a time into temporary storage, then handed to the
 * browser as a download. No resume. The temporary storage is OPFS (navigator.storage.getDirectory, on disk);
 * only browsers that can't write there keep the file in memory. Finished files are removed from the
 * temporary storage, so only the current file is held at a time.
 * (The "Save to folder" option with resume was removed; received files are always browser downloads.)
 */
import type { DownloadSink } from "../proto/remoteClient";

/** OPFS temporary folder. Cleared at startup (leftovers from last time). */
const TEMP_DIR = "peersync-temp";
/** How long a file handed to the download stays in temporary storage (so it isn't removed before the browser reads it). */
const TEMP_KEEP_MS = 5 * 60_000;

let opfsChecked: Promise<FileSystemDirectoryHandle | null> | null = null;

/** The OPFS temporary folder. null in browsers that can't write there (no createWritable). */
function tempDir(): Promise<FileSystemDirectoryHandle | null> {
  opfsChecked ??= (async () => {
    try {
      if (!navigator.storage?.getDirectory) return null;
      if (typeof FileSystemFileHandle === "undefined" || !("createWritable" in FileSystemFileHandle.prototype))
        return null;
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(TEMP_DIR, { create: true });
    } catch {
      return null;
    }
  })();
  return opfsChecked;
}

/** Where received files are buffered (for logs). */
export async function tempStorageKind(): Promise<"opfs" | "memory"> {
  return (await tempDir()) ? "opfs" : "memory";
}

/** Removes leftovers from last time (once at startup). */
export async function clearTempFiles(): Promise<number> {
  const dir = await tempDir();
  if (!dir) return 0;
  const names: string[] = [];
  for await (const name of (dir as any).keys() as AsyncIterable<string>) names.push(name);
  for (const n of names) await dir.removeEntry(n).catch(() => {});
  return names.length;
}

let tempSeq = 0;

/**
 * Receives one file into temporary storage and saves it as a download on commit.
 * No resume (offset is always 0).
 */
export class DownloadFileSink implements DownloadSink {
  private chunks: Uint8Array[] = [];
  private tempName: string | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private dir: FileSystemDirectoryHandle | null = null;

  /** fileName is the download's name (no folder part). */
  constructor(private fileName: string) {}

  async offset(): Promise<number> {
    return 0;
  }

  async start(pos: number): Promise<void> {
    if (pos !== 0) throw new Error("Resuming isn't supported in the browser.");
    this.chunks = [];
    this.dir = await tempDir();
    if (this.dir) {
      this.tempName = `${Date.now()}-${++tempSeq}`;
      const fh = await this.dir.getFileHandle(this.tempName, { create: true });
      this.writable = await fh.createWritable();
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.writable) await this.writable.write(chunk as Uint8Array<ArrayBuffer>);
    else this.chunks.push(chunk);
  }

  async commit(): Promise<string> {
    let file: Blob;
    if (this.writable && this.dir && this.tempName) {
      await this.writable.close();
      this.writable = null;
      // hand over the file on disk as is (not read into memory)
      file = await (await this.dir.getFileHandle(this.tempName)).getFile();
    } else {
      file = new Blob(this.chunks as BlobPart[]);
      this.chunks = [];
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.fileName;
    a.click();
    const dir = this.dir;
    const name = this.tempName;
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (dir && name) void dir.removeEntry(name).catch(() => {});
    }, TEMP_KEEP_MS);
    return this.fileName;
  }

  async abort(): Promise<void> {
    this.chunks = [];
    try {
      await this.writable?.abort();
    } catch {
      // already closed
    }
    this.writable = null;
    if (this.dir && this.tempName) await this.dir.removeEntry(this.tempName).catch(() => {});
  }
}
