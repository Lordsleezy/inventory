import { useEffect, useRef, useState } from "react";
import { DangerButton } from "./ui";

export type ViewerPhoto = { id: number; src: string; isPrimary: boolean };

type Pt = { x: number; y: number };

function gap(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function PhotoViewer({
  photos,
  start,
  onClose,
  onDelete,
  onPrimary,
  canEdit,
}: {
  photos: ViewerPhoto[];
  start: number;
  onClose: () => void;
  onDelete: (id: number) => Promise<void>;
  onPrimary: (id: number) => Promise<void>;
  canEdit: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);
  const [error, setError] = useState("");
  const [css, setCss] = useState("translate(0px, 0px) scale(1)");

  const scale = useRef(1);
  const tx = useRef(0);
  const ty = useRef(0);
  const pts = useRef(new Map<number, Pt>());
  const pinch0 = useRef(1);
  const scale0 = useRef(1);
  const pan0 = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const indexRef = useRef(index);
  const lenRef = useRef(photos.length);

  indexRef.current = index;
  lenRef.current = photos.length;

  function paint(nextScale: number, nextTx: number, nextTy: number) {
    scale.current = nextScale;
    tx.current = nextTx;
    ty.current = nextTy;
    setCss(`translate(${nextTx}px, ${nextTy}px) scale(${nextScale})`);
  }

  function resetView() {
    paint(1, 0, 0);
  }

  useEffect(() => {
    resetView();
    setError("");
  }, [index]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.current.size === 1) {
        pan0.current = { x: e.clientX, y: e.clientY, tx: tx.current, ty: ty.current };
      }
      if (pts.current.size === 2) {
        const [a, b] = [...pts.current.values()];
        pinch0.current = gap(a, b) || 1;
        scale0.current = scale.current;
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pts.current.has(e.pointerId)) return;
      pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.preventDefault();
      if (pts.current.size >= 2) {
        const [a, b] = [...pts.current.values()];
        const next = Math.min(6, Math.max(1, (scale0.current * gap(a, b)) / (pinch0.current || 1)));
        paint(next, tx.current, ty.current);
        return;
      }
      if (scale.current > 1.05) {
        paint(
          scale.current,
          pan0.current.tx + (e.clientX - pan0.current.x),
          pan0.current.ty + (e.clientY - pan0.current.y),
        );
      }
    };

    const onUp = (e: PointerEvent) => {
      const start = pan0.current;
      pts.current.delete(e.pointerId);
      if (pts.current.size !== 0) return;
      if (scale.current > 1.05) return;
      const dx = e.clientX - start.x;
      if (dx < -56 && indexRef.current < lenRef.current - 1) setIndex((i) => i + 1);
      else if (dx > 56 && indexRef.current > 0) setIndex((i) => i - 1);
      else paint(1, 0, 0);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const photo = photos[Math.min(index, photos.length - 1)];
  if (!photo) return null;

  return (
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label="Photo">
      <div ref={stageRef} className="photo-viewer-stage">
        {photo.src ? (
          <img src={photo.src} alt="" className="photo-viewer-img" style={{ transform: css }} draggable={false} />
        ) : (
          <p className="text-quiet text-floor-danger">file missing</p>
        )}
      </div>
      <div className="photo-viewer-bar">
        <button type="button" className="btn-text px-0 text-floor-text" onClick={onClose}>
          Close
        </button>
        <span className="text-quiet">
          {index + 1}/{photos.length}
          {photo.isPrimary ? " · Primary" : ""}
        </span>
        {canEdit && !photo.isPrimary ? (
          <button
            type="button"
            className="btn-text px-0 text-floor-text"
            onClick={() => void onPrimary(photo.id).catch((err) => setError(String(err)))}
          >
            Set primary
          </button>
        ) : (
          <span />
        )}
        {canEdit ? (
          <DangerButton
            idle="Delete"
            confirm="Delete photo"
            onConfirm={() => onDelete(photo.id)}
            onError={(err) => setError(err instanceof Error ? err.message : String(err))}
          />
        ) : null}
      </div>
      <p className="photo-viewer-hint text-quiet text-floor-mute">
        {photos.length > 1 ? "Swipe between photos. Pinch to zoom." : "Pinch to zoom."}
      </p>
      {error ? <p className="photo-viewer-hint text-quiet text-floor-danger">{error}</p> : null}
    </div>
  );
}
