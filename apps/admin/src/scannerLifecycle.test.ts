import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerLifecycle } from './scannerLifecycle.ts';

test('ten scan/background/resume cycles release tracks, clear video and blur inputs', () => {
  const doc = new EventTarget() as Document;
  const win = new EventTarget() as Window;
  let visibility = 'visible', blur = 0, stopped = 0, paused = 0;
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  Object.defineProperty(doc, 'activeElement', { get: () => ({ blur: () => blur++ }) });
  const video = { srcObject: null, pause: () => paused++ } as unknown as HTMLVideoElement;
  const stream = () => ({ getTracks: () => [{ stop: () => stopped++ }] }) as unknown as MediaStream;
  for (let i = 0; i < 10; i++) {
    visibility = 'visible';
    const owner = scannerLifecycle(doc, win, video);
    assert.equal(owner.attach(stream()), true);
    visibility = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(owner.stopped, true);
    assert.equal(video.srcObject, null);
    assert.equal(owner.attach(stream()), false, 'late getUserMedia resolution releases its tracks too');
    owner.stop();
  }
  assert.equal(stopped, 20);
  assert.ok(paused >= 10); assert.ok(blur >= 10);
});

test('pagehide releases the scanner even before visibility changes', () => {
  const doc = new EventTarget() as Document, win = new EventTarget() as Window;
  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
  let stopped = false;
  const owner = scannerLifecycle(doc, win);
  owner.attach({ getTracks: () => [{ stop: () => { stopped = true; } }] } as unknown as MediaStream);
  win.dispatchEvent(new Event('pagehide'));
  assert.equal(stopped, true); assert.equal(owner.stopped, true);
});
