import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/**
 * Getting data off the phone.
 *
 * On iOS a file is written to the app's Documents directory (so it is visible
 * in the Files app under "Floor" and included in device backups) and then
 * handed to the share sheet, which is how it reaches iCloud Drive, AirDrop,
 * Mail or a printer. In a browser the same call falls back to a download.
 */

const isWeb = () => Capacitor.getPlatform() === "web";

function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export type SavedFile = { filename: string; where: string };

/** Write a text file into Documents and offer to share it. */
export async function saveAndShare(
  filename: string,
  text: string,
  mime: string,
  title: string,
): Promise<SavedFile> {
  if (isWeb()) {
    download(filename, text, mime);
    return { filename, where: "your downloads folder" };
  }

  await Filesystem.writeFile({
    path: filename,
    directory: Directory.Documents,
    data: text,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Documents });

  try {
    await Share.share({ title, files: [uri] });
  } catch {
    // The share sheet being dismissed is not a failure; the file is written.
  }
  return { filename, where: "Files › On My iPhone › Floor" };
}

/** Read a text file the user picks. Used by restore. */
export async function readPickedTextFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json,text/plain";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? "") });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Open a receipt so it can be printed with AirPrint or saved as a PDF. */
export async function openHtml(filename: string, html: string): Promise<void> {
  if (isWeb()) {
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(html);
      win.document.close();
      return;
    }
    download(filename, html, "text/html");
    return;
  }
  await saveAndShare(filename, html, "text/html", "Receipt");
}

export function stampedName(prefix: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${prefix}-${stamp}.${extension}`;
}
