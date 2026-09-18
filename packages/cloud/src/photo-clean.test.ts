import assert from "node:assert/strict";
import test from "node:test";
import {
  approveAllClean,
  archiveStoragePath,
  brightnessGain,
  inspectCutout,
  nextVersionedFilename,
  nextVersionedStoragePath,
  parseOnlyFlag,
  folderMatchesSku,
  planCleanImport,
  uploadAction,
} from "./photo-clean.ts";

function rgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b, a] = fill(x, y);
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = a;
    }
  }
  return out;
}

test("too little subject is flagged for reshoot", () => {
  const img = rgba(20, 20, (x, y) => (x === 10 && y === 10 ? [200, 200, 200, 255] : [0, 0, 0, 0]));
  const flags = inspectCutout(img, 20, 20);
  assert.ok(flags.reshoot.includes("too little subject"));
  assert.equal(flags.exterior, false);
});

test("a full-frame opaque cutout is a failed cutout", () => {
  const img = rgba(12, 12, () => [120, 120, 120, 255]);
  const flags = inspectCutout(img, 12, 12);
  assert.ok(flags.reshoot.includes("failed cutout"));
});

test("a hollow ring looks like an interior", () => {
  const img = rgba(30, 30, (x, y) => {
    const edge = x < 4 || x > 25 || y < 4 || y > 25;
    return edge ? [180, 180, 180, 255] : [0, 0, 0, 0];
  });
  const flags = inspectCutout(img, 30, 30);
  assert.ok(flags.reshoot.includes("interior"));
  assert.equal(flags.looksDirty, false);
});

test("approve all clean skips generative and reshoot rows", () => {
  const next = approveAllClean([
    { reshoot: [], hasClean: true, hasGenerative: false, choice: "pending" },
    { reshoot: [], hasClean: true, hasGenerative: true, choice: "pending" },
    { reshoot: ["interior"], hasClean: true, hasGenerative: false, choice: "pending" },
  ]);
  assert.equal(next[0]?.choice, "clean");
  assert.equal(next[1]?.choice, "pending");
  assert.equal(next[2]?.choice, "pending");
});

test("upload skips unapproved and reshoot, replaces only a chosen clean or generative file", () => {
  assert.equal(uploadAction({ reshoot: ["dark glass"], hasClean: true, hasGenerative: false, choice: "clean" }).action, "skip");
  assert.equal(uploadAction({ reshoot: [], hasClean: true, hasGenerative: false, choice: "pending" }).action, "skip");
  assert.equal(uploadAction({ reshoot: [], hasClean: true, hasGenerative: false, choice: "original" }).action, "skip");
  assert.deepEqual(uploadAction({ reshoot: [], hasClean: true, hasGenerative: false, choice: "clean" }), {
    action: "replace",
    source: "clean",
  });
  assert.deepEqual(uploadAction({ reshoot: [], hasClean: true, hasGenerative: true, choice: "generative" }), {
    action: "replace",
    source: "generative",
  });
});

test("archive path is not under sku so the public catalog cannot read it", () => {
  const live = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/11203/11203-01.jpg";
  const arch = archiveStoragePath(live);
  assert.equal(arch, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/archive/11203/11203-01.jpg");
  assert.equal(arch.split("/")[1], "archive");
});

test("versioned live keys stay under store/sku and bump -vN", () => {
  const store = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(nextVersionedFilename("11203-01.jpg"), "11203-01-v2.jpg");
  assert.equal(nextVersionedFilename("11203-01-v2.jpg"), "11203-01-v3.jpg");
  assert.equal(
    nextVersionedStoragePath(`${store}/11203/11203-01.jpg`),
    `${store}/11203/11203-01-v2.jpg`,
  );
});

test("clean import matches folder+filename, skips extras and missing", () => {
  const plan = planCleanImport(
    [
      { folder: "11203-whirlpool", file: "11203-01.jpg" },
      { folder: "11203-whirlpool", file: "11203-02.jpg" },
    ],
    ["11203-whirlpool/11203-01.jpg", "11203-whirlpool/11203-99.jpg"],
  );
  assert.deepEqual(
    plan.toUpload.map((p) => p.file),
    ["11203-01.jpg"],
  );
  assert.deepEqual(plan.missing, ["11203-whirlpool/11203-02.jpg"]);
  assert.deepEqual(plan.extra, ["11203-whirlpool/11203-99.jpg"]);
});

test("--only matches a SKU folder prefix", () => {
  assert.deepEqual(parseOnlyFlag(["--only", "11203,10421"]), ["11203", "10421"]);
  assert.equal(folderMatchesSku("11203-whirlpool-wrs325", ["11203"]), true);
  assert.equal(folderMatchesSku("10421-ge-gts18", ["11203"]), false);
});

test("brightness gain stays bounded", () => {
  assert.ok(brightnessGain(80) > 1);
  assert.equal(brightnessGain(132), 1);
  assert.ok(brightnessGain(200) < 1);
});
