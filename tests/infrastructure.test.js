"use strict";

// Small DOM stand-in deliberately fails if the popup uses HTML injection.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateCollection, getCategory, createPopup } = require("../js/infrastructure.js");

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ""; this.className = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Never inject HTML into infrastructure popups"); }
  appendChild(child) { this.children.push(child); return child; }
  all(tag) { return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
}
const doc = { createElement: (tag) => new Element(tag) };

function feature(overrides = {}) {
  return {
    type: "Feature", geometry: { type: "Point", coordinates: [144.957, -37.809] },
    properties: {
      id: "test-bed-123", name: "Example bioretention bed", type: "bioretention_bed",
      location_precision: "official_asset_record_point",
      location_note: "Official asset-record point, not a surveyed boundary.",
      popup_en: "A garden-bed inventory record, not live performance data.",
      source_urls: ["https://data.melbourne.vic.gov.au/explore/dataset/example/"],
      current_operation: "not verified", source_date: "2023-03-14",
      attribution: "City of Melbourne; selected for this prototype.",
      license: "CC BY 4.0 (asset data)", license_url: "https://creativecommons.org/licenses/by/4.0/",
      ...overrides,
    },
  };
}
function collection(...features) { return { type: "FeatureCollection", features: features.length ? features : [feature()] }; }

test("accepts sourced features without mutation and returns the original collection", () => {
  const input = collection();
  const before = JSON.stringify(input);
  assert.strictEqual(validateCollection(input), input);
  assert.equal(JSON.stringify(input), before);
});

test("known asset types map to immutable readable marker categories", () => {
  const expected = {
    bioretention_bed: "raingardens", stormwater_harvesting_and_detention: "storage",
    roofwater_harvesting: "storage", raingarden_tree_pits: "treepits",
    infiltration_tree_pits: "treepits", permeable_pavement: "paving",
  };
  for (const [type, key] of Object.entries(expected)) {
    const category = getCategory(type);
    assert.equal(category.key, key);
    assert.ok(category.label.length > 4);
    assert.match(category.iconText, /^[A-Z]$/);
    assert.equal(Object.isFrozen(category), true);
    validateCollection(collection(feature({ type })));
  }
  for (const invalid of ["tank", "stormwater_pit", "__proto__", "constructor", undefined]) assert.throws(() => getCategory(invalid));
});

for (const [name, change] of [
  ["empty feature collection", (data) => { data.features = []; }],
  ["sparse features", (data) => { data.features = Array(1); }],
  ["wrong collection type", (data) => { data.type = "Feature"; }],
  ["service error", (data) => { data.error = { code: 500 }; }],
  ["truncated response", (data) => { data.exceededTransferLimit = true; }],
  ["null feature", (data) => { data.features[0] = null; }],
  ["missing properties", (data) => { delete data.features[0].properties; }],
  ["swapped latitude/longitude", (data) => { data.features[0].geometry.coordinates.reverse(); }],
  ["projected coordinates", (data) => { data.features[0].geometry.coordinates = [319827, 5813605]; }],
  ["nonfinite coordinates", (data) => { data.features[0].geometry.coordinates = [NaN, -37.809]; }],
  ["string coordinates", (data) => { data.features[0].geometry.coordinates = ["144.957", -37.809]; }],
  ["missing latitude", (data) => { data.features[0].geometry.coordinates = [144.957]; }],
  ["wrong geometry type", (data) => { data.features[0].geometry.type = "Polygon"; }],
  ["duplicate identity", (data) => { data.features.push(feature()); }],
  ["empty identity", (data) => { data.features[0].properties.id = " "; }],
  ["unknown type", (data) => { data.features[0].properties.type = "litter_trap"; }],
  ["missing name", (data) => { delete data.features[0].properties.name; }],
  ["missing description", (data) => { delete data.features[0].properties.popup_en; }],
  ["missing precision", (data) => { delete data.features[0].properties.location_precision; }],
  ["unsupported precision", (data) => { data.features[0].properties.location_precision = "exact"; }],
  ["missing location note", (data) => { delete data.features[0].properties.location_note; }],
  ["missing operational status", (data) => { delete data.features[0].properties.current_operation; }],
  ["missing attribution", (data) => { delete data.features[0].properties.attribution; }],
  ["missing licence", (data) => { delete data.features[0].properties.license; }],
  ["missing sources", (data) => { data.features[0].properties.source_urls = []; }],
  ["invalid optional source date", (data) => { data.features[0].properties.source_date = {}; }],
  ["capacity without context", (data) => { data.features[0].properties.documented_capacity_litres = 600000; }],
  ["negative capacity", (data) => { Object.assign(data.features[0].properties, { documented_capacity_litres: -10, capacity_context: "Published historic capacity." }); }],
]) {
  test(`fails closed for ${name}`, () => {
    const input = collection();
    change(input);
    assert.throws(() => validateCollection(input));
  });
}

test("a bad feature rejects an otherwise valid collection", () => {
  const input = collection(feature(), feature({ id: "second", source_urls: ["javascript:alert(1)"] }));
  assert.throws(() => validateCollection(input));
});

for (const badURL of ["javascript:alert(1)", "data:text/html,test", "http://example.test", "//example.test/path", "/local", "https://user:pass@example.test", "https://", " https://example.test", "https://example.test/\npath"]) {
  test(`rejects unsafe or invalid URL ${JSON.stringify(badURL)}`, () => {
    assert.throws(() => validateCollection(collection(feature({ source_urls: [badURL] }))));
    assert.throws(() => createPopup(feature({ license_url: badURL }), doc));
    assert.throws(() => createPopup(feature({ coordinate_source_url: badURL }), doc));
  });
}

test("approximate markers require their coordinate source and show conspicuous qualification", () => {
  for (const precision of ["site_representative", "street_section_representative", "intersection_representative"]) {
    const input = feature({ location_precision: precision });
    assert.throws(() => validateCollection(collection(input)));
    input.properties.coordinate_source_url = "https://data.melbourne.vic.gov.au/explore/dataset/street-names/";
    input.properties.coordinate_license = "CC BY 4.0";
    delete input.properties.license;
    validateCollection(collection(input));
    const popup = createPopup(input, doc);
    assert.match(popup.textContent, /Approximate project location/);
    assert.doesNotMatch(popup.textContent, /Official asset-record location/);
    assert.ok(popup.all("a").some((link) => link.textContent === "Coordinate source"));
  }
});

test("popup shows official precision without implying current performance or nearby protection", () => {
  const popup = createPopup(feature({ assessment_date: "2023-03-14", checked_on: "2026-10-18" }), doc);
  assert.equal(popup.tagName, "article");
  assert.equal(popup.className, "infrastructure-popup");
  assert.match(popup.textContent, /Official asset-record location/);
  assert.match(popup.textContent, /Current operation: not verified/);
  assert.match(popup.textContent, /does not establish current performance or flood protection/);
  assert.match(popup.textContent, /Asset assessment date: 2023-03-14/);
  assert.match(popup.textContent, /Sources checked: 2026-10-18 \(not a site inspection\)/);
  assert.match(popup.textContent, /City of Melbourne/);
  assert.match(popup.textContent, /CC BY 4.0/);
  const links = popup.all("a");
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.match(link.href, /^https:\/\//);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  assert.equal(popup.all("details").length, 1);
});

test("capacity is displayed only with its historical/current-storage context", () => {
  const popup = createPopup(feature({ type: "roofwater_harvesting", documented_capacity_litres: 600000,
    capacity_context: "Capacity from a 2013 case study, not current available storage.", documented_completion_year: 2006 }), doc);
  assert.match(popup.textContent, /600,000 L/);
  assert.match(popup.textContent, /2013 case study, not current available storage/);
  assert.match(popup.textContent, /historical source; not a current-condition check/);
});

test("missing dates are allowed and never replaced by invented dates", () => {
  const input = feature();
  delete input.properties.source_date;
  validateCollection(collection(input));
  const popup = createPopup(input, doc);
  assert.doesNotMatch(popup.textContent, /Source date|completion year|assessment date|Sources checked/);
});

test("untrusted labels and descriptions remain literal text, not markup", () => {
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const popup = createPopup(feature({ name: attack, popup_en: attack, location_note: attack, attribution: attack }), doc);
  assert.equal(popup.all("h3")[0].textContent, attack);
  assert.ok(popup.textContent.includes(attack));
  assert.equal(popup.all("script").length, 0);
  assert.equal(popup.all("img").length, 0);
});

test("browser global exposes the same public API and can build a popup with the default document", () => {
  const context = { window: { document: doc }, URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/infrastructure.js"), "utf8"), context);
  assert.deepEqual(Object.keys(context.window.Infrastructure), ["validateCollection", "getCategory", "createPopup"]);
  assert.strictEqual(context.window.Infrastructure.validateCollection(collection()).type, "FeatureCollection");
  assert.match(context.window.Infrastructure.createPopup(feature()).textContent, /Official asset-record location/);
});
