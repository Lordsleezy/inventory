import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePhotoFilename, stockPhotoFilename } from "./photo.ts";

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

test("uploads are renamed to SKU-timestamp.ext", () => {
  assert.equal(stockPhotoFilename("11130", "IMG_9999.JPEG", 1700000000000), "11130-1700000000000.jpg");
  assert.equal(stockPhotoFilename("11130", "door.PNG", 1), "11130-1.png");
  assert.equal(stockPhotoFilename("11130", "roll.heic", 2), "11130-2.heic");
  assert.equal(stockPhotoFilename("11130", "notes.txt", 3), null);
  assert.deepEqual(parsePhotoFilename("11130-1700000000000.jpg"), { sku: "11130" });
});
