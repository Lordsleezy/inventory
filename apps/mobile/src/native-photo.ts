export async function pickNativePhotos(): Promise<File[] | null> {
  try {
    const cap = await import("@capacitor/core");
    if (cap.Capacitor.getPlatform() === "web") return null;
    const camera = await import("@capacitor/camera");
    const photos = await camera.Camera.pickImages({ quality: 80, limit: 8 });
    const files: File[] = [];
    for (const photo of photos.photos) {
      if (!photo.webPath) continue;
      const res = await fetch(photo.webPath);
      const blob = await res.blob();
      files.push(
        new File([blob], photo.path?.split("/").pop() || "photo.jpg", { type: blob.type || "image/jpeg" }),
      );
    }
    return files.length ? files : null;
  } catch {
    return null;
  }
}
