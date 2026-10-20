"use strict";

// Run with: node --test tests/prototype-data.test.js. No network requests are made.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DATASETS, validateExtent } = require("../js/prototype-data.js");
const { prepareCollection, lookupPoint } = require("../js/address-lookup.js");

const ROOT = path.resolve(__dirname, "..");
const EXPECTED = [
  { id: "legacy_2100", file: "data/flood_extent_2100.json", scenario: "planning_overlay_union", data_kind: "planning_overlay", synthetic: false },
  { id: "demo_2010", file: "data/flood_extent_2010.json", scenario: "synthetic_demo_2010", data_kind: "synthetic_demo", synthetic: true },
];

function fixture(dataset = DATASETS[0]) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { scenario: dataset.scenario, data_kind: dataset.data_kind, synthetic: dataset.synthetic },
      geometry: { type: "Polygon", coordinates: [[[144.96, -37.82], [144.97, -37.82], [144.97, -37.81], [144.96, -37.81], [144.96, -37.82]]] },
    }],
  };
}

test("catalogue retains only 2100 and 2010 in their intended order", () => {
  assert.equal(DATASETS.length, 2);
  assert.deepEqual(DATASETS.map(({ id, file, scenario, data_kind, synthetic }) => ({ id, file, scenario, data_kind, synthetic })), EXPECTED);
  assert.deepEqual(DATASETS.map((dataset) => dataset.label), [
    "Flood Extent 2100 — 1% AEP (climate change scenario)",
    "Flood Extent 2010 (example only)",
  ]);
  assert.equal(new Set(DATASETS.map((dataset) => dataset.id)).size, 2);
  assert.equal(new Set(DATASETS.map((dataset) => dataset.file)).size, 2);
});

test("catalogue and every metadata entry are immutable", () => {
  assert.equal(Object.isFrozen(DATASETS), true);
  assert.throws(() => DATASETS.push({ id: "official" }), TypeError);
  for (const dataset of DATASETS) {
    assert.equal(Object.isFrozen(dataset), true);
    assert.throws(() => { dataset.synthetic = !dataset.synthetic; }, TypeError);
    assert.throws(() => { dataset.description = "Official model output"; }, TypeError);
  }
});

test("legacy display labels are qualified with their real planning/synthetic provenance", () => {
  assert.match(DATASETS[0].description, /Special Building Overlay \(SBO2 and SBO3\)/);
  assert.match(DATASETS[0].description, /18\.5% increase in rainfall intensity due to climate change by the year 2100\u201d \[1\]/);
  assert.deepEqual(DATASETS[0].references.map(({ marker }) => marker), ["[1]", "[2]"]);
  for (const { url } of DATASETS[0].references) assert.equal(new URL(url).protocol, "https:");
  assert.equal(Object.isFrozen(DATASETS[0].references), true);
  assert.deepEqual(DATASETS[1].references.map(({ marker }) => marker), ["[3]"]);
  assert.equal(new URL(DATASETS[1].references[0].url).protocol, "https:");
  assert.equal(Object.isFrozen(DATASETS[1].references), true);
  assert.match(DATASETS[1].description, /placeholder dataset/i);
  assert.match(DATASETS[1].description, /does not represent the actual 2010 flood extent/i);
  assert.match(DATASETS[1].description, /C384 Planning Amendment \[3\]\.$/);
  for (const dataset of DATASETS) {
    assert.equal(dataset.source_url, "scripts/transform.py");
    assert.equal(fs.existsSync(path.join(ROOT, dataset.source_url)), true);
    assert.equal(dataset.file.includes("official"), false);
    assert.equal(dataset.study_date, undefined);
    assert.equal(dataset.records_url, undefined);
    assert.equal(dataset.object_ids, undefined);
    assert.doesNotMatch(dataset.description, /official (?:model|scenario|snapshot)|Melbourne Water/i);
  }
});

test("browser global exposes the same catalogue and validator", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/prototype-data.js"), "utf8"), context);
  assert.deepEqual(Object.keys(context.window.PrototypeData), ["DATASETS", "validateExtent"]);
  assert.equal(JSON.stringify(context.window.PrototypeData.DATASETS), JSON.stringify(DATASETS));
  const input = fixture();
  assert.strictEqual(context.window.PrototypeData.validateExtent(input, DATASETS[0]), input);
});

for (const dataset of DATASETS) {
  test(`real ${dataset.id} file validates unchanged and prepares for local point checks`, () => {
    const input = JSON.parse(fs.readFileSync(path.join(ROOT, dataset.file), "utf8"));
    const before = JSON.stringify(input);
    assert.strictEqual(validateExtent(input, dataset), input);
    assert.equal(JSON.stringify(input), before);
    assert.ok(input.features.length > 0);
    for (const feature of input.features) {
      for (const field of ["scenario", "data_kind", "synthetic"]) assert.equal(feature.properties[field], dataset[field]);
      assert.equal(feature.properties.STUDY_NAME, undefined);
      assert.equal(feature.properties.FLOOD_EVENT, undefined);
      assert.equal(feature.properties.MODELLING_SCENARIO, undefined);
    }
    const prepared = prepareCollection(input);
    const result = lookupPoint([144.962, -37.813], prepared);
    assert.ok(["inside", "boundary", "outside"].includes(result.relation));
    assert.equal(JSON.stringify(input), before);
  });
}

test("metadata copies with the same identity/provenance are accepted without mutation", () => {
  for (const dataset of DATASETS) {
    const input = fixture(dataset);
    const metadata = Object.freeze({ ...dataset });
    assert.strictEqual(validateExtent(input, metadata), input);
  }
});

for (const [name, change] of [
  ["unknown ID", (metadata) => { metadata.id = "baseline"; }],
  ["missing ID", (metadata) => { delete metadata.id; }],
  ["different local file", (metadata) => { metadata.file = "data/official/baseline.geojson"; }],
  ["remote file", (metadata) => { metadata.file = "https://example.test/model.json"; }],
  ["different scenario", (metadata) => { metadata.scenario = "Existing Condition"; }],
  ["different kind", (metadata) => { metadata.data_kind = "official_model"; }],
  ["different synthetic flag", (metadata) => { metadata.synthetic = !metadata.synthetic; }],
  ["string synthetic flag", (metadata) => { metadata.synthetic = String(metadata.synthetic); }],
]) {
  test(`validator rejects metadata with ${name}`, () => {
    for (const dataset of DATASETS) {
      const metadata = { ...dataset };
      change(metadata);
      assert.throws(() => validateExtent(fixture(dataset), metadata));
    }
  });
}

test("validator rejects absent, primitive and unrecognised dataset metadata", () => {
  for (const metadata of [null, undefined, {}, [], 0, true, "legacy_2100"]) {
    assert.throws(() => validateExtent(fixture(), metadata));
  }
});

for (const [name, change] of [
  ["wrong collection type", (input) => { input.type = "Feature"; }],
  ["missing features", (input) => { delete input.features; }],
  ["non-array features", (input) => { input.features = {}; }],
  ["empty features", (input) => { input.features = []; }],
  ["sparse features", (input) => { input.features = Array(1); }],
  ["service error", (input) => { input.error = { code: 500, message: "Service unavailable" }; }],
  ["truncated service response", (input) => { input.exceededTransferLimit = true; }],
  ["null feature", (input) => { input.features[0] = null; }],
  ["wrong feature type", (input) => { input.features[0].type = "Polygon"; }],
  ["missing geometry", (input) => { delete input.features[0].geometry; }],
  ["null geometry", (input) => { input.features[0].geometry = null; }],
  ["missing properties", (input) => { delete input.features[0].properties; }],
  ["null properties", (input) => { input.features[0].properties = null; }],
  ["wrong scenario", (input) => { input.features[0].properties.scenario = "Yr 2100, RCP 8.5"; }],
  ["missing scenario", (input) => { delete input.features[0].properties.scenario; }],
  ["wrong kind", (input) => { input.features[0].properties.data_kind = "official_model"; }],
  ["missing kind", (input) => { delete input.features[0].properties.data_kind; }],
  ["wrong synthetic flag", (input) => { input.features[0].properties.synthetic = !input.features[0].properties.synthetic; }],
  ["missing synthetic flag", (input) => { delete input.features[0].properties.synthetic; }],
  ["string synthetic flag", (input) => { input.features[0].properties.synthetic = String(input.features[0].properties.synthetic); }],
]) {
  test(`validator rejects ${name}`, () => {
    for (const dataset of DATASETS) {
      const input = fixture(dataset);
      change(input);
      assert.throws(() => validateExtent(input, dataset));
    }
  });
}

test("validator rejects missing/primitive collection data and an error-only payload", () => {
  for (const input of [null, undefined, true, 0, "FeatureCollection", [], {}, { error: { code: 500 } }]) {
    assert.throws(() => validateExtent(input, DATASETS[0]));
  }
});

test("every feature is checked, not just the first feature", () => {
  for (const dataset of DATASETS) {
    const input = fixture(dataset);
    input.features.push(structuredClone(input.features[0]));
    assert.strictEqual(validateExtent(input, dataset), input);
    input.features[1].properties.synthetic = !dataset.synthetic;
    assert.throws(() => validateExtent(input, dataset));
  }
});

test("current-day data remains archived and cannot be accepted as an active layer", () => {
  const archived = {
    id: "demo_current", file: "data/flood_extent_current.json", scenario: "synthetic_demo_current",
    data_kind: "synthetic_demo", synthetic: true,
  };
  assert.equal(fs.existsSync(path.join(ROOT, archived.file)), true);
  const input = JSON.parse(fs.readFileSync(path.join(ROOT, archived.file), "utf8"));
  assert.throws(() => validateExtent(input, archived), /Unknown or inconsistent/);
  assert.throws(() => validateExtent(input, DATASETS[1]), /provenance/);
  assert.equal(DATASETS.some((dataset) => dataset.id === archived.id || dataset.file === archived.file), false);
});

test("passing provenance validation does not replace the separate geometry validation", () => {
  const input = fixture();
  input.features[0].geometry = { type: "LineString", coordinates: [[144.96, -37.82], [144.97, -37.81]] };
  assert.strictEqual(validateExtent(input, DATASETS[0]), input);
  assert.throws(() => prepareCollection(input));
});
