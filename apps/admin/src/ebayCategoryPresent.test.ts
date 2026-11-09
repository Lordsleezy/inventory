import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confidentCategory,
  ebayDetailsStatus,
  legacyCategoryRank,
  missingAspectNames,
  presentCategorySuggestions,
} from '../../../shared/ebay-category-present.mjs';

const CAT_FOOD = 'Meow Mix Original Choice Dry Cat Food, 3.15 lb bag';

const EBAY_LIKE = [
  { categoryId: '111', categoryName: 'Drywall Plaster & Joint Compounds', categoryPath: 'Home & Garden > Building & Hardware > Drywall Plaster & Joint Compounds' },
  { categoryId: '222', categoryName: 'Laundry Carts, Bags & Cleaners', categoryPath: 'Home & Garden > Household Supplies & Cleaning > Laundry Supplies > Laundry Carts, Bags & Cleaners' },
  { categoryId: '333', categoryName: 'Laundry Liquids', categoryPath: 'Home & Garden > Household Supplies & Cleaning > Laundry Detergents & Softeners > Laundry Liquids' },
  { categoryId: '444', categoryName: 'Dry Cat Food', categoryPath: 'Pet Supplies > Cat Supplies > Cat Food > Dry Cat Food' },
  { categoryId: '445', categoryName: 'Wet Cat Food', categoryPath: 'Pet Supplies > Cat Supplies > Cat Food > Wet Cat Food' },
];

const LOCAL_PATHS = EBAY_LIKE.map((row) => `Root > ${row.categoryPath}`);

test('the old substring search ranks drywall and laundry ahead of cat food', () => {
  const ranked = legacyCategoryRank(LOCAL_PATHS, CAT_FOOD);
  assert.match(ranked[0].path, /Drywall|Laundry/i);
  assert.ok(ranked.findIndex((row) => /Dry Cat Food/.test(row.path)) > 0);
});

test('cat food suggestions are pet food, never drywall or laundry', () => {
  const shown = presentCategorySuggestions(CAT_FOOD, EBAY_LIKE);
  assert.ok(shown.length > 0 && shown.length <= 4);
  assert.match(`${shown[0].category_name} ${shown[0].path}`, /cat food/i);
  for (const row of shown) {
    assert.doesNotMatch(`${row.category_name} ${row.path}`, /drywall|laundry/i);
  }
});

test('dry cat food pre-selects the dry leaf and plain cat food does not', () => {
  assert.equal(confidentCategory(CAT_FOOD, EBAY_LIKE)?.category_id, '444');
  assert.equal(confidentCategory('Meow Mix cat food', EBAY_LIKE), null);
});

test('other household titles stay on their own product type', () => {
  const cases: { title: string; good: RegExp; bad: RegExp }[] = [
    { title: 'Aroma 6-cup rice cooker', good: /rice cooker/i, bad: /drywall|laundry|cat food/i },
    { title: 'Pillowfort body pillow', good: /pillow/i, bad: /drywall|laundry/i },
    { title: 'DeWalt 20V cordless drill', good: /drill/i, bad: /drywall|laundry/i },
    { title: 'Logitech mouse pad', good: /mouse pad/i, bad: /drywall|laundry/i },
    { title: 'Black wrap dress', good: /dress/i, bad: /drywall|laundry/i },
  ];
  const library = [
    { categoryId: '1', categoryName: 'Drywall Plaster & Joint Compounds', categoryPath: 'Home & Garden > Drywall Plaster & Joint Compounds' },
    { categoryId: '2', categoryName: 'Laundry Detergents', categoryPath: 'Home & Garden > Laundry Detergents' },
    { categoryId: '3', categoryName: 'Rice Cookers', categoryPath: 'Home & Garden > Kitchen > Rice Cookers' },
    { categoryId: '4', categoryName: 'Pillows', categoryPath: 'Home & Garden > Bedding > Pillows' },
    { categoryId: '5', categoryName: 'Power Drills', categoryPath: 'Home & Garden > Tools > Power Drills' },
    { categoryId: '6', categoryName: 'Mouse Pads', categoryPath: 'Computers/Tablets & Networking > Mouse Pads' },
    { categoryId: '7', categoryName: 'Dresses', categoryPath: 'Clothing, Shoes & Accessories > Women > Dresses' },
  ];
  for (const item of cases) {
    const shown = presentCategorySuggestions(item.title, library);
    assert.ok(shown.some((row) => item.good.test(`${row.category_name} ${row.path}`)), item.title);
    for (const row of shown) assert.doesNotMatch(`${row.category_name} ${row.path}`, item.bad);
  }
});

test('aspects reject an empty required field, a value off the list, and a too-long value', () => {
  const fields = [
    { name: 'Flavor', required: true, allowed: ['Chicken', 'Fish'], selection_only: true },
    { name: 'Brand', required: true, allowed: [], selection_only: false, maxLength: 8 },
    { name: 'Type', required: false, allowed: ['Dry'], selection_only: true },
    { name: 'Features', required: true, multi: true, allowed: ['Grain Free', 'Indoor'], selection_only: true },
  ];
  assert.deepEqual(missingAspectNames(fields, {}), ['Flavor', 'Brand', 'Features']);
  assert.deepEqual(missingAspectNames(fields, { Flavor: 'Beef', Brand: 'Meow Mix Original', Features: 'Grain Free' }), ['Flavor', 'Brand']);
  assert.deepEqual(missingAspectNames(fields, { Flavor: 'Chicken', Brand: 'Meow', Features: 'Grain Free|Indoor' }), []);
});

test('details is ready only when the leaf, required aspects, and condition all pass', () => {
  const fields = [{ name: 'Flavor', required: true, allowed: ['Chicken'], selection_only: true }];
  assert.equal(ebayDetailsStatus({ categoryId: '', fields, attributes: {}, conditionAllowed: false }).text, 'Needs a category');
  assert.equal(ebayDetailsStatus({ categoryId: '444', fields, attributes: {}, conditionAllowed: true }).text, '1 required by eBay');
  assert.equal(ebayDetailsStatus({ categoryId: '444', fields, attributes: { Flavor: 'Chicken' }, conditionAllowed: false }).text, 'Condition');
  assert.equal(ebayDetailsStatus({ categoryId: '444', fields, attributes: { Flavor: 'Chicken' }, conditionAllowed: true }).text, 'Ready for eBay');
});

test('a section row gives the leftover width to the status, not the title', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'design', 'bw.css'), 'utf8');
  assert.match(css, /grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /input\[type=checkbox\].*width:\s*22px/s);
});
