import assert from "node:assert/strict";
import test from "node:test";
import { isWebDerivativePath, webDerivativePath, webDerivativePaths } from "./web-photos.ts";

const store = "11111111-1111-4111-8111-111111111111";

test("web derivatives sit beside the original and are not listing keys", () => {
  const live = `${store}/11130/front-v2.jpeg`;
  assert.equal(isWebDerivativePath(live), false);
  assert.equal(webDerivativePath(live, 400), `${store}/11130/web/400/front-v2.webp`);
  assert.equal(webDerivativePath(live, 1200), `${store}/11130/web/1200/front-v2.webp`);
  assert.deepEqual(webDerivativePaths(live), [
    `${store}/11130/web/400/front-v2.webp`,
    `${store}/11130/web/1200/front-v2.webp`,
  ]);
  assert.equal(isWebDerivativePath(`${store}/11130/web/400/front-v2.webp`), true);
});

test("archive keys are not turned into public web objects", () => {
  assert.throws(() => webDerivativePath(`${store}/archive/11130/front.jpeg`, 400));
});
