import test from "node:test";
import assert from "node:assert/strict";
import { parseCensusQuarters, quarterSeasonalFactors } from "./census-seasonality.mjs";

test("Census delimited quarters parse and yield centered seasonal factors", () => {
  const rows = parseCensusQuarters([
    "4th quarter 2025/1999440/365160/18.3/5.4/21.8/2.8/5.6",
    "3rd quarter 2025/1896573/299717/15.8/0.5/2.2/4.2/5.2",
    "2nd quarter 2025/1887093/293140/15.5/8.7/6.3/3.8/5.3",
    "1st quarter 2025/1735586/275715/15.9/-10.7/-20.3/3.2/5.6",
  ].join("\n"));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].quarter, 4);
  const factors = quarterSeasonalFactors(rows);
  assert.ok(factors[3] > factors[0]);
  assert.ok(Math.abs(factors.reduce((n, x) => n + x, 0) - 4) < 0.0001);
});
