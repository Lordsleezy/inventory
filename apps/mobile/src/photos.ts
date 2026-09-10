import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

/**
 * Photos are files, not database rows. They live under the app's Data
 * directory in a folder per SKU, and the database only stores the path.
 * Keeping the images out of the database keeps a backup of the records small
 * and quick even when there are thousands of pictures.
 */

const ROOT = "photos";

function newName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const salt = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${salt}.jpeg`;
}

export type PhotoSource = "camera" | "library";

/** Take or pick a photo and write it into the app's own storage. */
export async function capturePhoto(sku: string, source: PhotoSource): Promise<string> {
  const shot = await Camera.getPhoto({
    quality: 82,
    allowEditing: false,
    resultType: CameraResultType.Base64,
    source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
    saveToGallery: false,
    correctOrientation: true,
  });
  if (!shot.base64String) throw new Error("No image came back from the camera.");

  const path = `${ROOT}/${sku}/${newName()}`;
  await Filesystem.mkdir({ path: `${ROOT}/${sku}`, directory: Directory.Data, recursive: true }).catch(
    () => undefined, // already there
  );
  await Filesystem.writeFile({ path, directory: Directory.Data, data: shot.base64String });
  return path;
}

/** A URL the webview is allowed to render. */
export async function photoSrc(path: string): Promise<string> {
  if (Capacitor.getPlatform() === "web") {
    const read = await Filesystem.readFile({ path, directory: Directory.Data });
    return `data:image/jpeg;base64,${read.data as string}`;
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
  return Capacitor.convertFileSrc(uri);
}

export async function readPhotoBase64(path: string): Promise<string> {
  const read = await Filesystem.readFile({ path, directory: Directory.Data });
  return read.data as string;
}

export async function writePhotoBase64(path: string, base64: string): Promise<void> {
  const folder = path.split("/").slice(0, -1).join("/");
  if (folder) {
    await Filesystem.mkdir({ path: folder, directory: Directory.Data, recursive: true }).catch(
      () => undefined,
    );
  }
  await Filesystem.writeFile({ path, directory: Directory.Data, data: base64 });
}

export async function deletePhotoFile(path: string): Promise<void> {
  await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
}
