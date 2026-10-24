/** Loads OpenCV only when staff choose the measuring step. Coordinates are inches. */
export async function rectifyMatPhoto(file: File): Promise<string> {
  const imported = await import('@techstark/opencv-js');
  // OpenCV's generated bindings omit the aruco types from the package declarations.
  const cv = await imported.default as any;
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    image.src = url; await image.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const owned: any[] = [];
    const keep = (value: any) => { owned.push(value); return value; };
    try {
      const src = keep(cv.imread(canvas)), gray = keep(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const dictionary = keep(cv.getPredefinedDictionary(cv.DICT_4X4_50));
      const parameters = keep(new cv.aruco_DetectorParameters());
      const refine = keep(new cv.aruco_RefineParameters(10, 3, true));
      const detector = keep(new cv.aruco_ArucoDetector(dictionary, parameters, refine));
      const corners = keep(new cv.MatVector()), ids = keep(new cv.Mat()), rejected = keep(new cv.MatVector());
      detector.detectMarkers(gray, corners, ids, rejected);
      const selected = new Map<number, number[]>();
      for (let i = 0; i < ids.data32S.length; i++) {
        const id = ids.data32S[i];
        if (id < 0 || id > 3) continue;
        if (selected.has(id)) throw new Error('Use only one Floor mat in the photo.');
        const corner = corners.get(i);
        try { const index = [0, 1, 3, 2][id] * 2; selected.set(id, [corner.data32F[index], corner.data32F[index + 1]]); }
        finally { corner.delete(); }
      }
      if (selected.size !== 4) throw new Error('All four ArUco markers must be visible. Retake the photo with more light.');
      const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0,1,2,3].flatMap(id => selected.get(id)!)));
      const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [40,80,640,80,40,800,640,800]));
      const transform = keep(cv.getPerspectiveTransform(from, to)), result = keep(new cv.Mat());
      cv.warpPerspective(src, result, transform, new cv.Size(680, 880));
      canvas.width = 680; canvas.height = 880; cv.imshow(canvas, result);
      return canvas.toDataURL('image/jpeg', 0.9);
    } finally { for (const value of owned.reverse()) value.delete(); }
  } finally { URL.revokeObjectURL(url); }
}
