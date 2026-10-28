import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDimensions, dimensionIdentityMatches, dimensionWarnings } from './receive-dimensions.mjs';

test('Amazon then UPCitemdb supply dimensions; saved Floor values only fill gaps', () => {
  const result = mergeDimensions(
    { product_width_in: undefined, aspects: { product_height_in: 8, product_width_in: 2 }, package_length_in: 11 },
    { item: { width_in: 3, length_in: 2, weight_lb: 0.7 }, package: { width_in: 4 } },
    { package: { width_in: 5 } },
  );
  assert.equal(result.values.product_height_in, 8);
  assert.equal(result.sources.product_height_in, 'Floor');
  assert.equal(result.values.package_length_in, 11);
  assert.equal(result.sources.package_length_in, 'Floor');
  assert.equal(result.values.package_width_in, 4);
  assert.equal(result.sources.package_width_in, 'Amazon');
  assert.equal(result.values.package_height_in, null);
  assert.equal(result.sources.package_height_in, undefined);
  assert.equal(result.values.package_weight_lb, null);
});

test('unknown measurements stay unknown', () => {
  const result = mergeDimensions(null, null, null);
  assert.equal(Object.values(result.values).every(value => value == null), true);
});

test('a UPC-linked Amazon 24 oz can cannot supply dimensions for the 19.2 oz can', () => {
  const identity = {brand:'White Claw',title:'White Claw Black Cherry 19.2 fl oz Can',size:'19.2 fl oz',variant:'Black Cherry'};
  assert.equal(dimensionIdentityMatches({title:'White Claw Hard Seltzer Black Cherry 24 Fl. Oz.'}, identity),false);
  assert.equal(dimensionIdentityMatches({title:'White Claw Black Cherry Hard Seltzer 19.2 fl oz Can'}, identity),true);
});

test('old estimated weights cannot become sourced shipping measurements', () => {
  const result = mergeDimensions({package_weight_lb:4,dim_sources:{weight_lb:'estimated'}},
    {item:{weight_lb:2}}, null);
  assert.equal(result.values.product_weight_lb,2);
  assert.equal(result.values.package_weight_lb,null);
});

test('rejecting a non-matching catalog size does not warn when Amazon supplied usable measurements', () => {
  const result = mergeDimensions(null, { package: { length_in: 9, weight_lb: 0.77 } }, null);
  assert.deepEqual(dimensionWarnings(result.values), []);
});

test('the plain measurement warning appears only when no usable measurement exists', () => {
  assert.deepEqual(dimensionWarnings({package_length_in: null, package_weight_lb: null}),
    ['No size found. Measure on mat.']);
  assert.deepEqual(dimensionWarnings({product_height_in: 5, package_weight_lb: null}), []);
});

test('exact Febreze barcode accepts abbreviated Linen marketing text, preserving Amazon provenance', () => {
  const identity = {brand:'Febreze',title:'Febreze Air Effects Air Freshener Spray, Linen & Sky, 8.8 oz',size:'8.8 oz',variant:'Linen & Sky'};
  const catalog = {brand:'Febreze',title:'Febreze, Air Effects Linen, 8.8 Ounce',aspects:{Size:'8.8 Ounce (Pack of 1)'}};
  assert.equal(dimensionIdentityMatches(catalog,identity,{exactBarcode:true}),true);
  assert.equal(dimensionIdentityMatches({...catalog,title:'Febreze Air Effects Linen 17.6 Ounce',aspects:{}},identity,{exactBarcode:true}),false);
  assert.equal(dimensionIdentityMatches({...catalog,title:'Febreze Air Effects Linen 8.8 oz 3-Pack',aspects:{}},identity,{exactBarcode:true}),false);
  const merged = mergeDimensions({package_length_in:9.53,dim_sources:{length_in:'Amazon'}},null,null);
  assert.equal(merged.sources.package_length_in,'Amazon');
});
