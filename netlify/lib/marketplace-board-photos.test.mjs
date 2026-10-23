import assert from "node:assert/strict";
import test from "node:test";
import { web400Path } from "./marketplace-board.mjs";

const store = "11111111-1111-4111-8111-111111111111";

test("web400Path builds derivative beside original", () => {
  assert.equal(
    web400Path(`${store}/11130/front-v2.jpeg`),
    `${store}/11130/web/400/front-v2.webp`,
  );
});

test("web400Path skips archive and existing web paths", () => {
  assert.equal(web400Path(`${store}/archive/11130/front.jpeg`), null);
  assert.equal(web400Path(`${store}/11130/web/400/front.webp`), null);
  assert.equal(web400Path(`${store}/11130/web/1200/front.webp`), null);
});
