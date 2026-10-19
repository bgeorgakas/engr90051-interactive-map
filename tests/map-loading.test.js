"use strict";

// Integration tests execute the real browser scripts with small DOM/Leaflet
// stand-ins. No browser, CDN, geocoder or other network request is made.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const LEGACY_2100 = "data/flood_extent_2100.json";
const DEMO_2010 = "data/flood_extent_2010.json";
const DEMO_CURRENT = "data/flood_extent_current.json";
const INFRASTRUCTURE = "data/infrastructure.geojson";
const STORIES = "data/flood_stories.json";
const INFRASTRUCTURE_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, INFRASTRUCTURE), "utf8"));
const STORY_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, STORIES), "utf8"));
const CATALOG = [
  { id: "legacy_2100", file: LEGACY_2100, label: "2100 — 1% AEP (climate change)", data_kind: "planning_overlay", synthetic: false, scenario: "planning_overlay_union" },
  { id: "demo_2010", file: DEMO_2010, label: "2010 flood event (indicative)", data_kind: "synthetic_demo", synthetic: true, scenario: "synthetic_demo_2010" },
];
const SEARCH_CONFIG = "data/search-config.json";
const GEOCODER = "https://nominatim.openstreetmap.org/search";
const clone = (value) => structuredClone(value);

function extent(metadata, [west, south, east, north] = [144.96, -37.81, 144.97, -37.80]) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: metadata.id,
      properties: {
        data_kind: metadata.data_kind,
        synthetic: metadata.synthetic,
        scenario: metadata.scenario,
      },
      geometry: {
        type: "Polygon",
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
      },
    }],
  };
}

function ok(body) { return { ok: true, status: 200, json: async () => clone(body) }; }
function httpError(status = 503) { return { ok: false, status, json: async () => ({}) }; }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function searchConfig() {
  return { enabled: true, endpoint: GEOCODER, minIntervalMs: 1100, timeoutMs: 12000 };
}
function geocoded(label = "Public test place, Melbourne", lon = 144.965, lat = -37.805) {
  return { place_id: 1, display_name: label, lon: String(lon), lat: String(lat), addresstype: "building" };
}

class Element {
  constructor(tag = "div", ownerDocument = null) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.attributes = new Map();
    this.offsetWidth = 390;
    this.offsetHeight = 400;
    this.events = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
    this._text = "";
  }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(" "); }
  set innerHTML(value) { this.textContent = value; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  set src(value) { this.setAttribute("src", value); }
  get src() { return this.getAttribute("src") || ""; }
  focus(options) { if (this.ownerDocument) this.ownerDocument.activeElement = this; this.focusOptions = options; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(type, callback) { this.events.set(type, callback); }
  dispatch(type, event = {}) { return this.events.get(type)?.({ preventDefault() {}, ...event }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = (child) => selector.startsWith(".")
      ? child.classList.contains(selector.slice(1))
      : selector.startsWith("#") ? child.id === selector.slice(1) : child.tagName.toLowerCase() === selector.toLowerCase();
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

function harness(overrides = {}) {
  const smallLayer = extent({ ...CATALOG[0], id: "catchment" });
  const routes = new Map([
    ...CATALOG.map((dataset) => [dataset.file, () => ok(extent(dataset))]),
    ["data/catchment.json", () => ok(smallLayer)],
    [STORIES, () => ok(STORY_DATA)],
    [INFRASTRUCTURE, () => ok(INFRASTRUCTURE_DATA)],
    [SEARCH_CONFIG, () => ok(searchConfig())],
    ...Object.entries(overrides),
  ]);
  const prefixRoutes = new Map();
  const requests = [];
  const requestDetails = [];
  const errors = [];
  let nowMs = 0;
  const nodes = new Map();
  const document = { activeElement: null };
  const initiallyHidden = new Set([
    "map-load-warning", "retry-layer-data", "address-panel", "address-candidates",
    "address-selection", "address-retry-data", "retry-map-content", "story-panel", "story-image-notice",
  ]);
  const element = (id) => {
    if (!nodes.has(id)) {
      const node = new Element("div", document);
      node.id = id;
      node.hidden = initiallyHidden.has(id);
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  Object.assign(document, {
    getElementById: element,
    createElement: (tag) => new Element(tag, document),
    createTextNode: (text) => { const node = new Element("#text", document); node.textContent = text; return node; },
  });
  const map = {
    layers: new Set(), panes: new Map(), events: new Map(), views: [], viewOptions: [], pans: [],
    size: { x: 1280, y: 720 },
    setView(center, zoom, options) { this.views.push({ center: Array.from(center), zoom }); this.viewOptions.push(options); return this; },
    getSize() { return { ...this.size }; },
    panBy(offset) { this.pans.push(Array.from(offset)); return this; },
    fitBounds(bounds) { this.bounds = bounds; return this; },
    hasLayer(layer) { return this.layers.has(layer); },
    removeLayer(layer) { this.layers.delete(layer); return this; },
    createPane(name) { const pane = { style: {} }; this.panes.set(name, pane); return pane; },
    getPane(name) { return this.panes.get(name); },
    on(names, callback) { names.split(" ").forEach((name) => this.events.set(name, callback)); return this; },
    fire(name) { this.events.get(name)?.(); },
  };
  const control = {
    overlays: [],
    expanded: false,
    expand() { this.expanded = true; return this; },
    collapse() { this.expanded = false; return this; },
    addTo() { return this; },
    addOverlay(layer, name) { this.overlays.push({ layer, name }); return this; },
    removeLayer(layer) { this.overlays = this.overlays.filter((entry) => entry.layer !== layer); return this; },
  };
  const createdGeoJSON = [];
  const allMarkers = [];
  const bounds = { getWest: () => 144.95, getEast: () => 144.98, getNorth: () => -37.79, getSouth: () => -37.82 };
  function layer(kind, data) {
    return {
      kind, data, events: new Map(),
      addTo(target) { target.layers.add(this); return this; },
      addLayer(child) { (this.children ||= []).push(child); return this; },
      bindPopup(content, options) {
        this.popup = content;
        this.popupOptions = options;
        this.popupHandle = { update: () => { this.popupUpdates = (this.popupUpdates || 0) + 1; return this.popupHandle; } };
        return this;
      },
      getPopup() { return this.popupHandle; },
      openPopup() { this.popupOpened = true; return this; },
      zoomToShowLayer(child, callback) { this.zoomedTo = child; callback?.(); return this; },
      getChildCount() { return this.children?.length || 0; },
      getBounds() { return bounds; },
      on(name, callback) { this.events.set(name, callback); return this; },
    };
  }
  const L = {
    map: () => map,
    tileLayer: () => layer("base"),
    control: { layers: (_baseLayers, _overlays, options) => { control.options = options; return control; } },
    geoJSON(data, options) {
      const result = layer("geojson", data);
      result.options = options;
      createdGeoJSON.push(result);
      data.features.forEach((feature) => options.onEachFeature?.(feature, layer("feature", feature)));
      return result;
    },
    divIcon: (options) => options,
    marker(position, options) {
      const marker = layer("marker", Array.from(position));
      marker.options = options;
      allMarkers.push(marker);
      return marker;
    },
    markerClusterGroup: (options) => { const result = layer("cluster"); result.options = options; return result; },
  };
  const context = vm.createContext({
    L,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    performance: { now: () => nowMs },
    document,
    console: { error: (...args) => errors.push(args), log() {} },
    fetch: async (url, options) => {
      requests.push(url);
      requestDetails.push({ url, options });
      if (routes.has(url)) return routes.get(url)(url, options);
      for (const [prefix, responder] of prefixRoutes) {
        if (url.startsWith(prefix)) return responder(url, options);
      }
      throw new Error(`Unexpected stubbed request: ${url}`);
    },
  });
  for (const script of ["js/flood-data.js", "js/prototype-data.js", "js/address-lookup.js", "js/address-search.js", "js/address-panel.js", "js/infrastructure.js", "js/map.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }
  return {
    map, control, routes, requests, requestDetails, errors, element, document, createdGeoJSON, allMarkers,
    get markers() { return allMarkers.filter((marker) => marker.options?.title === "Selected address point"); },
    overlay(name) { return control.overlays.find((entry) => entry.name === name)?.layer; },
    evaluate: (expression) => vm.runInContext(expression, context),
    settle: () => new Promise(setImmediate),
    retry: () => element("retry-layer-data").dispatch("click"),
    retryContent: () => element("retry-map-content").dispatch("click"),
    layer(id) { return vm.runInContext(`prototypeLayers.get(${JSON.stringify(id)})`, context); },
    state(id) { return vm.runInContext(`prototypeStates.get(${JSON.stringify(id)})`, context); },
    countRequests(url) { return requests.filter((request) => request === url).length; },
    stubGeocoder(response) {
      prefixRoutes.set(`${GEOCODER}?`, typeof response === "function" ? response : () => ok(response));
    },
    geocoderRequests() { return requestDetails.filter(({ url }) => url.startsWith(`${GEOCODER}?`)); },
    submit(query) { element("address-search-input").value = query; return element("address-search").dispatch("submit"); },
    choose(index = 0) { return element("address-candidate-list").children[index].querySelector("button").dispatch("click"); },
    scenarioStatuses() { return element("address-scenarios").querySelectorAll(".scenario-status"); },
    advanceClock(milliseconds) { nowMs += milliseconds; },
  };
}

test("startup loads only the retained 2100 and 2010 flood layers in catalog order", async () => {
  const h = harness();
  assert.match(h.element("layer-status").textContent, /loading/i);
  assert.equal(h.element("retry-layer-data").hidden, true);
  await h.settle();
  const catalog = JSON.parse(h.evaluate("JSON.stringify(PrototypeData.DATASETS.map(({ id, label, file }) => ({ id, label, file })))"));
  assert.deepEqual(catalog, CATALOG.map(({ id, label, file }) => ({ id, label, file })));
  const displayed = h.control.overlays.filter(({ name }) => CATALOG.some((dataset) => dataset.label === name));
  assert.deepEqual(displayed.map(({ name }) => name), CATALOG.map(({ label }) => label));
  for (const dataset of CATALOG) {
    assert.equal(h.state(dataset.id), "loaded");
    assert.equal(h.map.hasLayer(h.layer(dataset.id)), true);
    assert.equal(h.countRequests(dataset.file), 1);
    assert.notEqual(h.layer(dataset.id).options.style.fill, false);
  }
  assert.deepEqual(CATALOG.map(({ id }) => h.layer(id).options.style.fillColor), ["#7dd3fc", "#a78bfa"]);
  assert.deepEqual(CATALOG.map(({ id }) => h.layer(id).options.style.fillOpacity), [0.35, 0.4]);
  assert.equal(h.countRequests(DEMO_CURRENT), 0);
  assert.equal(h.state("demo_current"), undefined);
  assert.equal(h.control.overlays.some(({ name }) => /Current day/.test(name)), false);
  assert.equal(h.requests.some((url) => url.startsWith("data/official/")), false);
  assert.equal(h.control.overlays.some(({ name }) => /Official baseline|Official 2100|2020 study|2017 study/.test(name)), false);
  assert.equal(h.errors.length, 0);
});

test("a failed prototype layer does not prevent the other retained layer loading", async () => {
  const h = harness({ [LEGACY_2100]: () => httpError(404) });
  await h.settle();
  assert.equal(h.state("legacy_2100"), "failed");
  assert.equal(h.state("demo_2010"), "loaded");
  assert.equal(h.map.hasLayer(h.layer("demo_2010")), true);
  assert.equal(h.countRequests(DEMO_CURRENT), 0);
  assert.equal(h.element("retry-layer-data").hidden, false);
  assert.match(h.element("layer-status").textContent, /not evidence of no flooding|does not mean no flooding/);
});

test("layer retry preserves loaded geometries without duplicate requests or controls", async () => {
  const h = harness({ [DEMO_2010]: () => httpError() });
  await h.settle();
  const planning = h.layer("legacy_2100");
  h.map.removeLayer(planning);
  h.map.fire("overlayremove");
  h.routes.set(DEMO_2010, () => ok(extent(CATALOG[1])));
  await h.retry();
  await h.settle();
  assert.strictEqual(h.layer("legacy_2100"), planning);
  assert.equal(h.map.hasLayer(planning), false, "Retry must not re-enable a layer the user hid");
  assert.equal(h.state("demo_2010"), "loaded");
  assert.equal(h.map.hasLayer(h.layer("demo_2010")), true);
  assert.equal(h.element("retry-layer-data").hidden, true);
  assert.equal(h.countRequests(LEGACY_2100), 1);
  assert.equal(h.countRequests(DEMO_2010), 2);
  assert.equal(h.countRequests(DEMO_CURRENT), 0);
  for (const { label } of CATALOG) {
    assert.equal(h.control.overlays.filter(({ name }) => name === label).length, 1);
  }
  await h.retry();
  assert.equal(h.countRequests(DEMO_2010), 2);
  assert.equal(h.requests.some((url) => url.startsWith("data/official/")), false);
});

test("address membership uses the distinct geometry displayed by each prototype layer", async () => {
  const geometries = [
    extent(CATALOG[0], [144.964, -37.806, 144.966, -37.804]),
    extent(CATALOG[1], [144.965, -37.81, 144.97, -37.80]),
  ];
  const h = harness(Object.fromEntries(CATALOG.map((dataset, index) => [dataset.file, () => ok(geometries[index])])));
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  const expected = ["inside", "boundary"];
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), expected.map((relation) => `scenario-status ${relation}`));
  CATALOG.forEach((dataset, index) => {
    assert.deepEqual(h.layer(dataset.id).data, geometries[index]);
    assert.equal(h.evaluate(`AddressLookup.lookupPoint([144.965, -37.805], prototypePrepared.get(${JSON.stringify(dataset.id)})).relation`), expected[index]);
    assert.equal(h.control.overlays.find(({ name }) => name === dataset.label).layer, h.layer(dataset.id));
    assert.equal(h.countRequests(dataset.file), 1);
    h.map.removeLayer(h.layer(dataset.id));
  });
  h.map.fire("overlayremove");
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), expected.map((relation) => `scenario-status ${relation}`));
  assert.equal(h.requests.some((url) => url.startsWith("data/official/")), false);
});

for (const [description, mutate] of [
  ["incorrect kind", (data) => { data.features[0].properties.data_kind = "official_model"; }],
  ["incorrect scenario", (data) => { data.features[0].properties.scenario = "synthetic_demo_current"; }],
  ["incorrect synthetic flag", (data) => { data.features[0].properties.synthetic = true; }],
  ["missing geometry", (data) => { data.features[0].geometry = null; }],
  ["empty features", (data) => { data.features = []; }],
]) {
  test(`planning layer with ${description} fails closed for display and address checks`, async () => {
    const badData = extent(CATALOG[0]);
    mutate(badData);
    const h = harness({ [LEGACY_2100]: () => ok(badData) });
    h.stubGeocoder([geocoded()]);
    await h.settle();
    assert.equal(h.state("legacy_2100"), "failed");
    assert.equal(h.createdGeoJSON.some(({ data }) => data.features.some((feature) => feature.properties?.scenario === "planning_overlay_union" && feature.id === "legacy_2100")), false);
    await h.submit("Public test place Melbourne");
    h.choose();
    assert.equal(h.scenarioStatuses()[0].className, "scenario-status unavailable");
    assert.equal(h.scenarioStatuses()[1].className, "scenario-status inside");
    assert.equal(h.scenarioStatuses().length, 2);
  });
}

test("malformed prototype JSON fails visibly without being treated as an empty valid layer", async () => {
  const h = harness({ [DEMO_2010]: () => ({ ok: true, json: async () => { throw new SyntaxError("Bad JSON"); } }) });
  await h.settle();
  assert.equal(h.state("demo_2010"), "failed");
  assert.equal(h.element("retry-layer-data").hidden, false);
  assert.match(h.element("layer-status").textContent, /2010 flood event.*failed/);
});

test("overlapping retries while a prototype layer is loading do not duplicate requests", async () => {
  const pending = deferred();
  const h = harness({ [LEGACY_2100]: () => pending.promise });
  await h.retry();
  await h.retry();
  assert.equal(h.countRequests(LEGACY_2100), 1);
  pending.resolve(ok(extent(CATALOG[0])));
  await h.settle();
  for (const dataset of CATALOG) {
    assert.equal(h.countRequests(dataset.file), 1);
    assert.equal(h.state(dataset.id), "loaded");
  }
});

test("catalog order stays stable when prototype files respond in reverse order", async () => {
  const pending = CATALOG.map(() => deferred());
  const h = harness(Object.fromEntries(CATALOG.map((dataset, index) => [dataset.file, () => pending[index].promise])));
  pending[1].resolve(ok(extent(CATALOG[1])));
  await h.settle();
  pending[0].resolve(ok(extent(CATALOG[0])));
  await h.settle();
  const names = h.control.overlays.filter(({ name }) => CATALOG.some((dataset) => dataset.label === name)).map(({ name }) => name);
  assert.deepEqual(names, CATALOG.map(({ label }) => label));
  h.stubGeocoder([geocoded()]);
  await h.submit("Public test place Melbourne");
  h.choose();
  assert.deepEqual(h.element("address-scenarios").children.map((card) => card.querySelector("h4").textContent), CATALOG.map(({ label }) => label));
});

test("shown and hidden prototype status follows layer control events", async () => {
  const h = harness();
  await h.settle();
  h.map.removeLayer(h.layer("demo_2010"));
  h.map.fire("overlayremove");
  assert.match(h.element("layer-status").textContent, /2010 flood event \(indicative\): loaded · hidden/);
  h.layer("demo_2010").addTo(h.map);
  h.map.fire("overlayadd");
  assert.match(h.element("layer-status").textContent, /2010 flood event \(indicative\): loaded · shown/);
});

test("catchment failure retains a fallback map view and does not hide prototype data", async () => {
  const h = harness({ "data/catchment.json": () => httpError() });
  await h.settle();
  assert.deepEqual(h.map.views[0], { center: [-37.811, 144.962], zoom: 15 });
  assert.equal(h.map.bounds, undefined);
  for (const { id } of CATALOG) assert.equal(h.state(id), "loaded");
  assert.equal(h.element("map-load-warning").hidden, false);
  assert.match(h.element("map-load-warning").textContent, /Elizabeth Street catchment/);
  assert.match(h.element("map-load-warning").textContent, /Missing data does not mean no flooding/);
});

test("historic-story failure is separate from successful prototype loading", async () => {
  const h = harness({ "data/flood_stories.json": () => httpError() });
  await h.settle();
  for (const { id } of CATALOG) assert.equal(h.state(id), "loaded");
  assert.match(h.element("map-load-warning").textContent, /Historic flood stories/);
});

test("infrastructure loads eight sourced markers under a separate toggle and visible list", async () => {
  const h = harness();
  await h.settle();
  const group = h.overlay("Flood infrastructure (WSUD)");
  assert.ok(group);
  assert.equal(group.getChildCount(), 8);
  assert.equal(h.map.hasLayer(group), true);
  assert.equal(h.element("infrastructure-list").children.length, 8);
  assert.match(h.element("infrastructure-status").textContent, /8 asset \/ project markers.*approximate/);
  assert.equal(h.countRequests(INFRASTRUCTURE), 1);
  assert.equal(h.control.overlays.filter(({ name }) => name === "Flood infrastructure (WSUD)").length, 1);
  assert.deepEqual(group.children.map((marker) => marker.options.title), INFRASTRUCTURE_DATA.features.map(({ properties }) => properties.name));
  INFRASTRUCTURE_DATA.features.forEach((feature, index) => {
    const [lon, lat] = feature.geometry.coordinates;
    assert.deepEqual(group.children[index].data, [lat, lon]);
    assert.equal(group.children[index].options.icon.className, "infrastructure-marker");
  });
  const [first] = group.children;
  h.map.removeLayer(group);
  h.element("infrastructure-list").children[0].querySelector("button").dispatch("click");
  assert.equal(h.map.hasLayer(group), true);
  assert.equal(group.zoomedTo, first);
  assert.equal(first.popupOpened, true);
  assert.equal(h.markers.length, 0, "Infrastructure selection must not create an address-risk marker");
  assert.equal(h.scenarioStatuses().length, 0);
});

test("infrastructure popups distinguish three asset records from five approximate project points", async () => {
  const h = harness();
  await h.settle();
  const markers = h.overlay("Flood infrastructure (WSUD)").children;
  let official = 0;
  let approximate = 0;
  markers.forEach((marker, index) => {
    const feature = INFRASTRUCTURE_DATA.features[index];
    const popup = marker.popup;
    const badge = popup.querySelector(".infrastructure-precision");
    if (feature.properties.location_precision === "official_asset_record_point") {
      official += 1;
      assert.equal(badge.textContent, "Official asset-record location");
    } else {
      approximate += 1;
      assert.equal(badge.textContent, "Approximate project location");
    }
    assert.ok(popup.textContent.includes(feature.properties.location_note));
    assert.match(popup.textContent, /does not establish current performance or flood protection/);
    assert.match(popup.textContent, /Current operation:/);
    assert.match(popup.textContent, /Attribution:/);
    assert.ok(popup.querySelectorAll("a").length > 0);
    for (const link of popup.querySelectorAll("a")) {
      assert.match(link.href, /^https:\/\//);
      assert.equal(link.rel, "noopener noreferrer");
    }
  });
  assert.equal(official, 3);
  assert.equal(approximate, 5);
});

test("infrastructure clusters and list selection avoid animation-driven mobile popup removal", async () => {
  const h = harness();
  h.map.size = { x: 320, y: 480 };
  await h.settle();
  const group = h.overlay("Flood infrastructure (WSUD)");
  assert.equal(group.options.animate, false);
  assert.equal(group.options.animateAddingMarkers, false);
  assert.equal(group.options.removeOutsideVisibleBounds, false);
  assert.equal(group.options.maxClusterRadius, 32);
  const marker = group.children[0];
  assert.equal(marker.popupOptions.maxWidth, 250);
  assert.equal(marker.popupOptions.maxHeight, 340);
  assert.deepEqual(Array.from(marker.popupOptions.autoPanPaddingTopLeft), [15, 80]);
  assert.deepEqual(Array.from(marker.popupOptions.autoPanPaddingBottomRight), [15, 15]);
  h.element("infrastructure-list").querySelector("button").dispatch("click");
  assert.equal(h.map.viewOptions.at(-1).animate, false);
  assert.equal(marker.popupOpened, true);
});

test("infrastructure popup events set layout state and focus content without scrolling", async () => {
  const h = harness();
  await h.settle();
  const marker = h.overlay("Flood infrastructure (WSUD)").children[0];
  assert.equal(marker.popup.getAttribute("tabindex"), "-1");
  assert.equal(marker.popupOptions.maxWidth, 320);
  assert.equal(marker.popupOptions.maxHeight, 360);
  h.map.fire("popupopen");
  marker.events.get("popupopen")();
  assert.equal(h.element("map-layout").classList.contains("popup-open"), true);
  assert.strictEqual(h.document.activeElement, marker.popup);
  assert.equal(marker.popup.focusOptions.preventScroll, true);
  h.map.fire("popupclose");
  assert.equal(h.element("map-layout").classList.contains("popup-open"), false);
});

test("toggling infrastructure source details updates popup dimensions and preserves scroll position", async () => {
  const h = harness();
  await h.settle();
  const marker = h.overlay("Flood infrastructure (WSUD)").children[0];
  const container = new Element("div", h.document);
  container.scrollTop = 190;
  marker.popup.parentElement = container;
  let updates = 0;
  marker.getPopup().update = () => { updates += 1; container.scrollTop = 0; };
  marker.popup.querySelector("details").dispatch("toggle");
  assert.equal(updates, 1);
  assert.equal(container.scrollTop, 190);
});

for (const [name, responder] of [
  ["HTTP failure", () => httpError()],
  ["invalid JSON", () => ({ ok: true, json: async () => { throw new SyntaxError("Bad infrastructure JSON"); } })],
  ["invalid coordinates", () => {
    const broken = clone(INFRASTRUCTURE_DATA);
    broken.features.at(-1).geometry.coordinates = [320000, 5815000];
    return ok(broken);
  }],
]) {
  test(`infrastructure ${name} fails without partial markers and retries without duplicate content`, async () => {
    const h = harness({ [INFRASTRUCTURE]: responder });
    await h.settle();
    assert.equal(h.overlay("Flood infrastructure (WSUD)"), undefined);
    assert.equal(h.allMarkers.filter((marker) => marker.options.icon?.className === "infrastructure-marker").length, 0);
    assert.equal(h.element("infrastructure-list").children.length, 0);
    assert.match(h.element("map-load-warning").textContent, /Flood infrastructure/);
    assert.equal(h.element("retry-map-content").hidden, false);
    for (const { id } of CATALOG) assert.equal(h.state(id), "loaded");
    assert.equal(h.overlay("Historic flood stories").getChildCount(), 5);
    h.routes.set(INFRASTRUCTURE, () => ok(INFRASTRUCTURE_DATA));
    h.retryContent();
    await h.settle();
    const group = h.overlay("Flood infrastructure (WSUD)");
    assert.equal(group.getChildCount(), 8);
    assert.equal(h.element("infrastructure-list").children.length, 8);
    assert.equal(h.element("retry-map-content").hidden, true);
    assert.equal(h.element("map-load-warning").hidden, true);
    assert.equal(h.countRequests(INFRASTRUCTURE), 2);
    assert.equal(h.countRequests(STORIES), 1);
    h.map.removeLayer(group);
    h.retryContent();
    await h.settle();
    assert.equal(h.countRequests(INFRASTRUCTURE), 2);
    assert.equal(h.map.hasLayer(group), false, "Retry must not re-enable successfully loaded optional content");
    assert.equal(h.control.overlays.filter(({ name }) => name === "Flood infrastructure (WSUD)").length, 1);
  });
}

test("overlapping content retries do not duplicate in-flight infrastructure requests", async () => {
  const pending = deferred();
  const h = harness({ [INFRASTRUCTURE]: () => pending.promise });
  h.retryContent();
  h.retryContent();
  assert.equal(h.countRequests(INFRASTRUCTURE), 1);
  pending.resolve(ok(INFRASTRUCTURE_DATA));
  await h.settle();
  assert.equal(h.overlay("Flood infrastructure (WSUD)").getChildCount(), 8);
  assert.equal(h.control.overlays.filter(({ name }) => name === "Flood infrastructure (WSUD)").length, 1);
});

test("historical stories show five records for four events with chronological list and source notes", async () => {
  const h = harness();
  await h.settle();
  const group = h.overlay("Historic flood stories");
  assert.equal(group.getChildCount(), 5);
  assert.match(h.element("story-status").textContent, /5 records · 4 historical events.*not flood extents/);
  const buttons = h.element("story-list").querySelectorAll("button");
  assert.deepEqual(buttons.map((button) => button.textContent), [...STORY_DATA].sort((a, b) => a.year - b.year).map((story) => story.title));
  h.map.removeLayer(group);
  buttons.at(-1).dispatch("click");
  assert.equal(h.map.hasLayer(group), true);
  assert.equal(h.element("story-panel").hidden, false);
  assert.match(h.element("story-panel-title").textContent, /6 March 2010/);
  assert.match(h.element("story-panel-description").textContent, /does not establish the flood depth or risk at an individual address/);
  assert.match(h.element("story-panel-meta").textContent, /2010-03-06.*does not validate.*illustrative 2010 flood layer/);
  assert.equal(h.element("story-panel-image").style.display, "none");
  assert.equal(h.element("story-panel-image").getAttribute("src"), null);
  assert.equal(h.element("story-panel-links").querySelectorAll("a").length, 2);
  assert.match(h.element("story-panel-links").textContent, /Bureau of Meteorology/);
  assert.equal(h.scenarioStatuses().length, 0);
});

test("archive story media failures preserve readable text, credit and original source links", async () => {
  const h = harness();
  await h.settle();
  const archive = STORY_DATA.find((story) => story.year === 1862);
  const button = h.element("story-list").querySelectorAll("button").find((node) => node.textContent === archive.title);
  button.dispatch("click");
  const image = h.element("story-panel-image");
  assert.equal(image.src, new URL(archive.image).href);
  image.dispatch("error");
  assert.equal(image.style.display, "none");
  assert.equal(h.element("story-image-notice").hidden, false);
  assert.equal(h.element("story-panel-description").textContent, archive.description);
  assert.equal(h.element("story-panel-credit").textContent, archive.credit);
  assert.ok(h.element("story-panel-links").querySelectorAll("a").some((link) => link.href.includes("handle.slv.vic.gov.au")));
  image.dispatch("load");
  assert.equal(h.element("story-image-notice").hidden, true);
});

test("story images use descriptive alt text and fall back to the legacy title", async () => {
  const h = harness();
  await h.settle();
  const buttons = h.element("story-list").querySelectorAll("button");
  const archive = STORY_DATA.find((story) => story.year === 1862);
  buttons.find((button) => button.textContent === archive.title).dispatch("click");
  assert.equal(h.element("story-panel-image").alt, archive.image_alt);
  const legacy = STORY_DATA.find((story) => story.id === "1972-elizabeth-street");
  buttons.find((button) => button.textContent === legacy.title).dispatch("click");
  assert.equal(h.element("story-panel-image").alt, legacy.title);
});

test("story provenance includes source attribution, rights, checked date and coordinate licence links", async () => {
  const h = harness();
  await h.settle();
  const archive = STORY_DATA.find((story) => story.year === 1882);
  const buttons = h.element("story-list").querySelectorAll("button");
  buttons.find((button) => button.textContent === archive.title).dispatch("click");
  const provenance = h.element("story-provenance-content");
  assert.ok(provenance.textContent.includes(archive.coordinate_attribution));
  assert.ok(provenance.textContent.includes(archive.media_rights_note));
  assert.ok(provenance.textContent.includes(`Sources checked: ${archive.checked_on} (not the event date).`));
  assert.deepEqual(provenance.querySelectorAll("a").map((link) => link.href), [archive.coordinate_source_url, archive.coordinate_license_url]);
  assert.deepEqual(provenance.querySelectorAll("a").map((link) => link.textContent), ["Representative location source", archive.coordinate_license]);
  for (const link of provenance.querySelectorAll("a")) {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  assert.equal(h.element("story-provenance").open, false);
  h.element("story-provenance").open = true;
  const legacy = STORY_DATA.find((story) => story.id === "1972-elizabeth-street");
  buttons.find((button) => button.textContent === legacy.title).dispatch("click");
  assert.equal(h.element("story-provenance").open, false, "A newly opened story starts with collapsed source details");
  assert.equal(provenance.textContent, legacy.media_rights_note);
  assert.equal(provenance.querySelectorAll("a").length, 0);
  assert.doesNotMatch(provenance.textContent, /out of copyright|Sources checked:/, "Previous story rights must not carry over to legacy media");
});

test("unsafe optional coordinate URLs cannot become story provenance links", async () => {
  const stories = clone(STORY_DATA);
  const archive = stories.find((story) => story.year === 1862);
  archive.coordinate_source_url = "javascript:alert(1)";
  archive.coordinate_license_url = "https://user:password@example.test/licence";
  const h = harness({ [STORIES]: () => ok(stories) });
  await h.settle();
  h.element("story-list").querySelectorAll("button").find((button) => button.textContent === archive.title).dispatch("click");
  assert.equal(h.element("story-provenance-content").querySelectorAll("a").length, 0);
  assert.ok(h.element("story-provenance-content").textContent.includes(archive.coordinate_attribution));
  assert.ok(h.element("story-panel-links").querySelectorAll("a").length > 0);
});

for (const [name, mutate] of [
  ["empty array", (stories) => stories.splice(0)],
  ["blank title", (stories) => { stories.at(-1).title = "   "; }],
  ["blank ID", (stories) => { stories.at(-1).id = " \t "; }],
  ["missing ID", (stories) => { delete stories.at(-1).id; }],
  ["non-string ID", (stories) => { stories.at(-1).id = 2010; }],
  ["duplicate ID", (stories) => { stories.at(-1).id = stories[0].id; }],
  ["missing links", (stories) => { delete stories.at(-1).links; }],
  ["non-array links", (stories) => { stories.at(-1).links = {}; }],
  ["null link", (stories) => { stories.at(-1).links.push(null); }],
  ["missing link label", (stories) => { delete stories.at(-1).links[0].label; }],
  ["non-string link label", (stories) => { stories.at(-1).links[0].label = 5; }],
  ["missing URL", (stories) => { delete stories.at(-1).links[0].url; }],
  ["JavaScript URL", (stories) => { stories.at(-1).links[0].url = "javascript:alert(1)"; }],
  ["plain HTTP URL", (stories) => { stories.at(-1).links[0].url = "http://example.test/story"; }],
  ["credential-bearing URL", (stories) => { stories.at(-1).links[0].url = "https://user:password@example.test/story"; }],
  ["relative URL", (stories) => { stories.at(-1).links[0].url = "/story"; }],
]) {
  test(`story ${name} rejects the whole collection before creating markers or links`, async () => {
    const broken = clone(STORY_DATA);
    mutate(broken);
    const h = harness({ [STORIES]: () => ok(broken) });
    await h.settle();
    assert.equal(h.overlay("Historic flood stories"), undefined);
    assert.equal(h.element("story-list").children.length, 0);
    assert.equal(h.allMarkers.filter((marker) => marker.options.icon?.className === "flood-marker").length, 0);
    assert.match(h.element("story-status").textContent, /could not be loaded/);
    assert.match(h.element("map-load-warning").textContent, /Historic flood stories/);
    assert.equal(h.element("retry-map-content").hidden, false);
    assert.equal(h.overlay("Flood infrastructure (WSUD)").getChildCount(), 8);
    for (const { id } of CATALOG) assert.equal(h.state(id), "loaded");
  });
}

test("malformed story locations fail atomically while infrastructure remains available and retry is isolated", async () => {
  const broken = clone(STORY_DATA);
  broken.at(-1).lat = 144.96;
  const h = harness({ [STORIES]: () => ok(broken) });
  await h.settle();
  assert.equal(h.overlay("Historic flood stories"), undefined);
  assert.equal(h.element("story-list").children.length, 0);
  assert.equal(h.overlay("Flood infrastructure (WSUD)").getChildCount(), 8);
  assert.equal(h.element("retry-map-content").hidden, false);
  h.routes.set(STORIES, () => ok(STORY_DATA));
  h.retryContent();
  await h.settle();
  assert.equal(h.overlay("Historic flood stories").getChildCount(), 5);
  assert.equal(h.countRequests(STORIES), 2);
  assert.equal(h.countRequests(INFRASTRUCTURE), 1);
  assert.equal(h.element("retry-map-content").hidden, true);
  h.retryContent();
  await h.settle();
  assert.equal(h.countRequests(STORIES), 2);
  assert.equal(h.control.overlays.filter(({ name }) => name === "Historic flood stories").length, 1);
});

test("source explanations distinguish planning boundaries from synthetic demo data", async () => {
  const h = harness();
  await h.settle();
  const content = h.element("dataset-sources").textContent;
  for (const { label } of CATALOG) assert.ok(content.includes(label));
  assert.match(content, /planning/i);
  assert.match(content, /synthetic/i);
  assert.doesNotMatch(content, /Official baseline|2017-08-31|2020-08-13/);
});

test("address submit requires explicit selection before checking the same two displayed geometries", async () => {
  const h = harness();
  h.stubGeocoder([geocoded(), geocoded("Another public test place", 144.968, -37.807)]);
  await h.settle();
  assert.equal(h.geocoderRequests().length, 0, "Startup must not send an address query");
  assert.equal(h.element("address-panel").hidden, true);

  await h.submit("Public test place Melbourne");
  assert.equal(h.geocoderRequests().length, 1);
  const request = h.geocoderRequests()[0];
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("q"), "Public test place Melbourne");
  assert.equal(url.searchParams.get("viewbox"), "144.95,-37.79,144.98,-37.82");
  assert.equal(url.searchParams.get("countrycodes"), "au");
  assert.equal(url.searchParams.get("bounded"), null);
  assert.equal(request.options.credentials, "omit");
  assert.equal(h.element("address-panel").hidden, false);
  assert.equal(h.element("address-panel").getAttribute("aria-busy"), "false");
  assert.equal(h.element("map-layout").classList.contains("address-open"), true);
  assert.equal(h.element("address-candidate-list").children.length, 2);
  assert.equal(h.element("address-selection").hidden, true);
  assert.equal(h.markers.length, 0, "A geocoder match must not be chosen automatically");

  h.choose();
  assert.equal(h.element("address-candidates").hidden, true);
  assert.equal(h.element("address-selection").hidden, false);
  assert.equal(h.element("selected-address").textContent, "Public test place, Melbourne");
  assert.match(h.element("selected-coordinate").textContent, /-37\.80500, 144\.96500/);
  assert.strictEqual(h.document.activeElement, h.element("selected-address"));
  assert.deepEqual(h.markers[0].data, [-37.805, 144.965]);
  assert.equal(h.map.hasLayer(h.markers[0]), true);
  assert.deepEqual(h.map.views.at(-1), { center: [-37.805, 144.965], zoom: 17 });
  assert.deepEqual(h.map.pans.at(-1), [195, 0]);
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), Array(2).fill("scenario-status inside"));
  const content = h.element("address-scenarios").textContent;
  assert.match(content, /Planning map · not a prediction for 2100/);
  assert.match(content, /Example only · not a record of the 2010 flood/);
  assert.match(h.element("address-snapshot").textContent, /both areas, even if you hide them/);
  assert.doesNotMatch(content, /Current day/);
  for (const dataset of CATALOG) {
    assert.equal(h.countRequests(dataset.file), 1);
    const mapGeometry = h.layer(dataset.id).data;
    const preparedResult = h.evaluate(`AddressLookup.lookupPoint([144.965, -37.805], prototypePrepared.get(${JSON.stringify(dataset.id)})).relation`);
    assert.equal(preparedResult, "inside");
    assert.equal(mapGeometry.features[0].properties.scenario, dataset.scenario);
  }
  assert.equal(h.requests.some((url) => url.startsWith("data/official/")), false);
  assert.equal(h.errors.length, 0);
});

test("an empty geocoder response leaves no selected point or model result", async () => {
  const h = harness();
  h.stubGeocoder([]);
  await h.settle();
  await h.submit("Unknown public landmark Melbourne");
  assert.match(h.element("address-search-status").textContent, /No matching location/);
  assert.equal(h.element("address-candidates").hidden, true);
  assert.equal(h.element("address-selection").hidden, true);
  assert.equal(h.markers.length, 0);
  assert.equal(h.scenarioStatuses().length, 0);
});

test("address layer-data retry refreshes the selected result without a new search or duplicate pin", async () => {
  const h = harness({ [DEMO_2010]: () => httpError() });
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  const pin = h.markers[0];
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), ["scenario-status inside", "scenario-status unavailable"]);
  assert.equal(h.element("address-retry-data").hidden, false);

  h.routes.set(DEMO_2010, () => ok(extent(CATALOG[1])));
  h.element("address-retry-data").dispatch("click");
  await h.settle();
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), Array(2).fill("scenario-status inside"));
  assert.equal(h.element("address-retry-data").hidden, true);
  assert.equal(h.countRequests(LEGACY_2100), 1);
  assert.equal(h.countRequests(DEMO_2010), 2);
  assert.equal(h.countRequests(DEMO_CURRENT), 0);
  assert.equal(h.geocoderRequests().length, 1);
  assert.equal(h.markers.length, 1);
  assert.equal(h.map.hasLayer(pin), true);
  assert.equal(h.map.hasLayer(h.layer("demo_2010")), true);
});

test("a selected point updates automatically when pending prototype data finishes loading", async () => {
  const planning = deferred();
  const h = harness({ [LEGACY_2100]: () => planning.promise });
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), ["scenario-status loading", "scenario-status inside"]);
  assert.equal(h.element("address-retry-data").hidden, true);
  planning.resolve(ok(extent(CATALOG[0])));
  await h.settle();
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), Array(2).fill("scenario-status inside"));
  assert.equal(h.geocoderRequests().length, 1);
  assert.equal(h.markers.length, 1);
});

test("address HTML and rendered results omit removed catchment, code links and disabled layer buttons", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(html, /id=["']address-catchment["']/);
  assert.doesNotMatch(html, /class=["']address-panel-notice["']/);
  const css = fs.readFileSync(path.join(ROOT, "css/style.css"), "utf8");
  assert.match(css, /#address-search-status:empty\s*\{\s*display:\s*none;\s*\}/);
  const h = harness();
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  assert.equal(h.element("address-search-status").textContent, "");
  for (const [index, card] of h.element("address-scenarios").children.entries()) {
    assert.equal(card.querySelector(".scenario-status").textContent, "This address is within the flood prone area");
    assert.equal(card.querySelector("button"), null);
    assert.equal(card.querySelector(".scenario-actions"), null);
    assert.equal(card.querySelectorAll("a").length, index === 0 ? 2 : 0);
    assert.doesNotMatch(card.textContent, /Map data|How this area was created|Layer shown on map/);
  }
});

test("the map catchment remains loaded without an address catchment result", async () => {
  const catchment = extent({ ...CATALOG[0], id: "catchment" }, [144.96, -37.81, 144.963, -37.80]);
  const h = harness({ "data/catchment.json": () => ok(catchment) });
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  assert.equal(h.countRequests("data/catchment.json"), 1);
  assert.equal(h.control.overlays.some(({ name }) => /Elizabeth Street catchment/.test(name)), true);
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), Array(2).fill("scenario-status inside"));
});

test("outside prototype extents within the catchment does not claim safety or official assessment coverage", async () => {
  const smallerBounds = [144.96, -37.81, 144.963, -37.80];
  const h = harness({
    [LEGACY_2100]: () => ok(extent(CATALOG[0], smallerBounds)),
    [DEMO_2010]: () => ok(extent(CATALOG[1], smallerBounds)),
  });
  h.stubGeocoder([geocoded()]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  assert.deepEqual(h.scenarioStatuses().map((node) => node.className), Array(2).fill("scenario-status outside"));
  for (const card of h.element("address-scenarios").children) {
    assert.match(card.textContent, /Being outside this area does not mean the location is safe from flooding/);
  }
});

test("a hidden prototype layer is checked and can be shown without changing the result", async () => {
  const h = harness();
  h.stubGeocoder([geocoded()]);
  await h.settle();
  h.map.removeLayer(h.layer("demo_2010"));
  h.map.fire("overlayremove");
  assert.equal(h.map.hasLayer(h.layer("demo_2010")), false);
  await h.submit("Public test place Melbourne");
  h.choose();
  const futureCard = h.element("address-scenarios").children[1];
  assert.equal(futureCard.querySelector(".scenario-status").className, "scenario-status inside");
  assert.match(futureCard.textContent, /2010 flood event \(indicative\)/);
  assert.match(futureCard.textContent, /Example only · not a record of the 2010 flood/);
  assert.equal(futureCard.querySelector("button").textContent, "Show layer on map");
  futureCard.querySelector("button").dispatch("click");
  assert.equal(h.map.hasLayer(h.layer("demo_2010")), true);
  const refreshed = h.element("address-scenarios").children[1];
  assert.equal(refreshed.querySelector(".scenario-status").className, "scenario-status inside");
  assert.equal(refreshed.querySelector("button"), null);
  assert.equal(refreshed.querySelector(".scenario-actions"), null);
  assert.doesNotMatch(refreshed.textContent, /Layer shown on map/);
  assert.equal(h.countRequests(DEMO_2010), 1);
  assert.equal(h.geocoderRequests().length, 1);
});

test("responsive layer controls collapse on mobile and recenter the selected pin above the result sheet", async () => {
  const h = harness();
  h.stubGeocoder([geocoded()]);
  assert.equal(h.control.options.collapsed, true, "Leaflet must retain its collapsible control behavior");
  assert.equal(h.control.expanded, true, "Desktop controls are expanded explicitly");
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  const pin = h.markers[0];
  const beforeResizeViews = h.map.views.length;
  const beforeResizePans = h.map.pans.length;

  h.map.size.x = 390;
  h.element("address-panel").offsetHeight = 360;
  h.map.fire("resize");
  assert.equal(h.control.expanded, false);
  assert.equal(h.map.views.length, beforeResizeViews + 1);
  assert.equal(h.map.pans.length, beforeResizePans + 1);
  assert.deepEqual(h.map.views.at(-1), { center: [-37.805, 144.965], zoom: 17 });
  assert.deepEqual(h.map.pans.at(-1), [0, 180]);

  h.map.size.x = 1280;
  h.map.fire("resize");
  assert.equal(h.control.expanded, true);
  assert.equal(h.map.views.length, beforeResizeViews + 2);
  assert.equal(h.map.pans.length, beforeResizePans + 2);
  assert.deepEqual(h.map.pans.at(-1), [195, 0]);
  assert.equal(h.map.hasLayer(pin), true);
  assert.equal(h.markers.length, 1);
  assert.equal(h.geocoderRequests().length, 1);
});

test("reopening address search on mobile collapses manually expanded layer controls", async () => {
  const h = harness();
  h.stubGeocoder([geocoded()]);
  await h.settle();
  h.map.size.x = 390;
  h.map.fire("resize");
  await h.submit("Public test place Melbourne");
  h.choose();
  h.element("address-panel-close").dispatch("click");
  h.control.expand();
  assert.equal(h.control.expanded, true);

  const reopened = h.submit("Public test place Melbourne");
  assert.equal(h.control.expanded, false, "Opening the mobile results panel collapses controls immediately");
  await reopened;
  assert.equal(h.element("address-panel").hidden, false);
  assert.equal(h.element("address-candidates").hidden, false);
  assert.equal(h.element("address-selection").hidden, true);
  assert.equal(h.geocoderRequests().length, 1, "The same search uses its in-memory cache");
});

for (const action of ["close", "edit"]) {
  test(`a search ${action === "close" ? "closed" : "edited"} before configuration loads never dispatches to the geocoder`, async () => {
    const config = deferred();
    const h = harness({ [SEARCH_CONFIG]: () => config.promise });
    h.stubGeocoder([geocoded()]);
    const pendingSearch = h.submit("Public test place Melbourne");
    assert.equal(h.element("address-panel").getAttribute("aria-busy"), "true");
    if (action === "close") h.element("address-panel-close").dispatch("click");
    else {
      h.element("address-search-input").value = "Changed public place Melbourne";
      h.element("address-search-input").dispatch("input");
    }
    config.resolve(ok(searchConfig()));
    await pendingSearch;
    await h.settle();
    assert.equal(h.geocoderRequests().length, 0);
    assert.equal(h.element("address-panel").getAttribute("aria-busy"), "false");
    assert.equal(h.element("address-selection").hidden, true);
    assert.equal(h.element("address-candidate-list").children.length, 0);
    assert.equal(h.markers.length, 0);
    if (action === "close") {
      assert.equal(h.element("address-panel").hidden, true);
      assert.strictEqual(h.document.activeElement, h.element("address-search-input"));
    } else assert.match(h.element("address-search-status").textContent, /Location changed/);
  });
}

for (const [description, response] of [
  ["disabled", () => ok({ ...searchConfig(), enabled: false })],
  ["unavailable", () => httpError()],
  ["invalid", () => ok({ ...searchConfig(), endpoint: "javascript:invalid" })],
  ["enabled but missing an endpoint", () => ok({ enabled: true, minIntervalMs: 1100, timeoutMs: 12000 })],
]) {
  test(`${description} address configuration shows an unavailable message without sending the query`, async () => {
    const h = harness({ [SEARCH_CONFIG]: response });
    h.stubGeocoder([geocoded()]);
    await h.settle();
    await h.submit("Public test place Melbourne");
    assert.equal(h.geocoderRequests().length, 0);
    assert.match(h.element("address-search-status").textContent, /Address search is unavailable/);
    assert.equal(h.element("address-panel").getAttribute("aria-busy"), "false");
    assert.equal(h.element("address-selection").hidden, true);
    assert.equal(h.markers.length, 0);
    assert.equal(h.state("legacy_2100"), "loaded");
  });
}

test("a stale geocoder response cannot replace a newer search even if the transport ignores abort", async () => {
  const firstResponse = deferred();
  const h = harness();
  h.stubGeocoder((url) => new URL(url).searchParams.get("q").startsWith("First")
    ? firstResponse.promise : ok([geocoded("Second public place, Melbourne", 144.968, -37.807)]));
  await h.settle();
  const firstSearch = h.submit("First public place Melbourne");
  await h.settle();
  assert.equal(h.geocoderRequests().length, 1);
  const firstSignal = h.geocoderRequests()[0].options.signal;
  h.advanceClock(1100);
  await h.submit("Second public place Melbourne");
  await firstSearch;
  assert.equal(firstSignal.aborted, true);
  assert.match(h.element("address-candidate-list").textContent, /Second public place/);

  firstResponse.resolve(ok([geocoded("First stale place, Melbourne")]));
  await h.settle();
  assert.equal(h.geocoderRequests().length, 2);
  assert.match(h.element("address-candidate-list").textContent, /Second public place/);
  assert.doesNotMatch(h.element("address-candidate-list").textContent, /stale/);
  h.choose();
  assert.equal(h.element("selected-address").textContent, "Second public place, Melbourne");
  assert.deepEqual(h.markers[0].data, [-37.807, 144.968]);
});

test("editing or closing a selected address clears its pin and restores usable focus", async () => {
  const h = harness();
  h.stubGeocoder([geocoded(), geocoded("Another public test place", 144.968, -37.807)]);
  await h.settle();
  await h.submit("Public test place Melbourne");
  h.choose();
  h.element("address-change-location").dispatch("click");
  assert.equal(h.map.hasLayer(h.markers[0]), false);
  assert.equal(h.element("address-selection").hidden, true);
  assert.strictEqual(h.document.activeElement, h.element("address-candidate-list").querySelector("button"));
  h.choose(1);
  const secondPin = h.markers[1];
  assert.equal(h.map.hasLayer(secondPin), true);
  h.element("address-search-input").value = "Changed public place Melbourne";
  h.element("address-search-input").dispatch("input");
  assert.equal(h.map.hasLayer(secondPin), false);
  assert.equal(h.element("address-candidate-list").children.length, 0);
  assert.equal(h.scenarioStatuses().length, 0);
  h.element("address-panel").dispatch("keydown", { key: "Escape" });
  assert.equal(h.element("address-panel").hidden, true);
  assert.equal(h.element("map-layout").classList.contains("address-open"), false);
  assert.strictEqual(h.document.activeElement, h.element("address-search-input"));
});
