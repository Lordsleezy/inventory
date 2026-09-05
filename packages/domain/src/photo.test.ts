import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePhotoFilename } from "./photo.ts";

test("SKU.jpg and SKU-2.jpg and SKU_left_door.jpg map to the SKU", () => {
  assert.deepEqual(parsePhotoFilename("11130.jpg"), { sku: "11130" });
  assert.deepEqual(parsePhotoFilename("11130-2.jpg"), { sku: "11130" });
  assert.deepEqual(parsePhotoFilename("11130_left_door.jpg"), { sku: "11130" });
  assert.deepEqual(parsePhotoFilename("C:\\\\drop\\\\11130.PNG"), { sku: "11130" });
});

test("non-SKU names do not match", () => {
  assert.equal(parsePhotoFilename("notes.txt"), null);
  assert.equal(parsePhotoFilename("photo.jpg"), null);
  assert.equal(parsePhotoFilename("1113.jpg"), null);
  assert.equal(parsePhotoFilename("11130.pdf"), null);
});
