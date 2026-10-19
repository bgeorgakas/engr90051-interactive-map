"use strict";

// Run the real controller and geometry with DOM/geocoder stand-ins. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../js/address-panel.js");
const { prepareCollection, lookupPoint } = require("../js/address-lookup.js");

const DATA_FILES = ["data/flood_extent_2100.json", "data/flood_extent_2010.json"];
const LAYER_LABELS = ["2100 — 1% AEP (climate change)", "2010 flood event (indicative)"];
const AEP_DEFINITION = "https://www.melbournewater.com.au/about/publications/news/what-1-100-year-flood-event";
const EXTENT_SOURCE = "https://participate.melbourne.vic.gov.au/amendment-c384";
const CLIMATE_SOURCE = "https://www.climatecouncil.org.au/resources/climate-change-floods/";
const PLANNING_TOPICS = ["What does 1% AEP mean?", "What does 2100 flood extent represent?", "How does climate change influence flooding?"];
const DEMO_TOPICS = ["What does 2010 flood extent represent?"];
// Requested screenshot copy is an editorial fixture, not validation of the map data.
const SCREENSHOT_PARAGRAPHS = {
  aep: [
    "A 1% annual exceedance probability (AEP) means a flood of a particular size that has a 1% chance of occurring in any year.",
    "You may hear this called a “1 in 100-year flood”, but it does not mean it happens only once every 100 years. These floods can occur close together, even in consecutive years. Therefore, a recent flood does not mean your area is safe from another.",
    "Flood maps show areas that could be affected, but cannot tell you when flooding will happen. Knowing your risk, preparing a flood plan and following official warnings can help you stay safe.",
  ],
  extent2100: [
    "The 2100 flood extent shows areas that may be affected by a severe flood with a 1% chance of occurring in any year. It includes flooding associated with both Melbourne Water’s main drains and the City of Melbourne’s council drains, assuming rainfall intensity increases by 18.5% due to climate change by 2100. It is a planning scenario, not an exact prediction of future flooding.",
  ],
  climate: [
    "Climate change can make flooding more likely and more severe. As the air gets warmer, it can hold more water. This can lead to heavier rain falling in a shorter time. When too much rain falls quickly, drains and waterways may not be able to carry it away, causing water to build up in streets and low-lying areas. Warmer conditions can also give storms more energy and produce heavier rainfall. This means floods may happen more often, spread further and cause damage to homes, roads and services. Understanding this risk can help communities prepare and stay safer during severe weather.",
  ],
  extent2010: [
    "The 2010 flood extent is an indicative map created for this website by trimming the larger 2100 flood extent. It provides a visual comparison showing how the mapped flood area could expand under projected climate conditions by 2100. However, it is not an official flood model, a verified boundary, or a record of where flooding occurred in 2010. Properties within the indicative area may not flood during every severe storm, while properties outside it may still be affected. The map should therefore be used only to support community awareness and discussion, not for property-specific assessment, planning, insurance, or emergency decisions.",
  ],
};

class BasicElement {
  constructor(tagName, document) {
    this.tagName = tagName.toLowerCase();
    this.document = document;
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.scrollTop = 0;
    this.value = "";
    this.className = "";
    this._text = "";
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(" "); },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Panel must build safe text nodes, not assign innerHTML"); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(type, callback) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(callback);
  }
  dispatch(type, details = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...details };
    let result;
    for (const callback of this.events.get(type) || []) result = callback(event);
    return result;
  }
  click() { if (!this.disabled) return this.dispatch("click"); }
  focus(options) { this.document.activeElement = this; this.focusOptions = options; }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith(".")
      ? node.classList.contains(selector.slice(1))
      : node.tagName === selector.toLowerCase();
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function square(x = 0, y = 0, size = 10) {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function prepared(rings = [square()], id = 1) {
  return prepareCollection({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { OBJECTID: id }, geometry: { type: "Polygon", coordinates: rings } }],
  });
}

function dataContext() {
  return {
    catchment: { state: "loaded", prepared: prepared([square(-20, -20, 40)]) },
    datasets: [
      {
        id: "legacy_2100", state: "loaded", prepared: prepared(), visible: true,
        metadata: { id: "legacy_2100", label: LAYER_LABELS[0], data_kind: "planning_overlay", description: "Planning boundary geometry, not a verified future model.", file: DATA_FILES[0], source_url: "https://example.test/planning-source" },
      },
      {
        id: "demo_2010", state: "loaded", prepared: prepared([square(2, 2, 10)], 2), visible: false,
        metadata: { id: "demo_2010", label: LAYER_LABELS[1], data_kind: "synthetic_demo", description: "Synthetic demonstration, not an observed flood event.", file: DATA_FILES[1], source_url: "scripts/transform.py" },
      },
    ],
  };
}

function candidate(overrides = {}) {
  return { label: "Example public landmark, Melbourne", lon: 5, lat: 5, kind: "landmark", ...overrides };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ context = dataContext(), results = [candidate()], search } = {}) {
  const nodes = new Map();
  const document = {
    activeElement: null,
    createElement: (tag) => new BasicElement(tag, document),
    getElementById(id) {
      if (["address-catchment", "address-snapshot"].includes(id)) throw new Error(`Removed address UI must not be requested: ${id}`);
      if (!nodes.has(id)) nodes.set(id, new BasicElement("div", document));
      return nodes.get(id);
    },
  };
  const node = (id) => document.getElementById(id);
  for (const id of ["address-panel", "address-candidates", "address-selection", "address-retry-data"]) node(id).hidden = true;
  const calls = { search: [], cancel: 0, selected: [], clear: 0, showLayer: [], retry: 0, recenter: [], open: 0, lookup: [] };
  const viewbox = [144.94, -37.79, 144.99, -37.84];
  const searchClient = {
    cancel() { calls.cancel += 1; },
    search(query, options) {
      calls.search.push({ query, options });
      return search ? search(query, options) : Promise.resolve(results);
    },
  };
  const controller = create({
    document, searchClient,
    lookupPoint: (point, collection) => {
      calls.lookup.push({ point, collection });
      return lookupPoint(point, collection);
    },
    getViewbox: () => viewbox,
    getData: () => context,
    onSelect: (result) => calls.selected.push(result),
    onClear: () => { calls.clear += 1; },
    onShowLayer: (id) => {
      calls.showLayer.push(id);
      context.datasets.find((entry) => entry.id === id).visible = true;
    },
    onRetry: () => { calls.retry += 1; },
    onRecenter: (result) => calls.recenter.push(result),
    onOpen: () => { calls.open += 1; },
  });
  return {
    document, node, calls, controller, context, viewbox,
    search(value = "Example landmark Melbourne") {
      node("address-search-input").value = value;
      return node("address-search").dispatch("submit");
    },
    choose(index = 0) { node("address-candidate-list").children[index].querySelector("button").click(); },
    card(index) { return node("address-scenarios").children[index]; },
  };
}

test("a search requires explicit candidate choice even for one result", async () => {
  const result = candidate();
  const h = harness({ results: [result] });
  await h.search("Public landmark Melbourne");
  assert.deepEqual(h.calls.search, [{ query: "Public landmark Melbourne", options: { viewbox: h.viewbox } }]);
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.open, 1);
  assert.equal(h.node("address-panel").hidden, false);
  assert.equal(h.node("map-layout").classList.contains("address-open"), true);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.deepEqual(h.calls.selected, []);
  assert.match(h.node("address-search-status").textContent, /1 match found.*Choose/);
  h.choose();
  assert.deepEqual(h.calls.selected, [result]);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, false);
  assert.equal(h.node("selected-address").textContent, result.label);
  assert.equal(h.document.activeElement, h.node("selected-address"));
  assert.equal(h.node("address-scenarios").children.length, 2);
  assert.equal(h.node("address-search-status").textContent, "");
});

test("selection clears its status and later searches restore progress, matches, no-results and errors", async () => {
  for (const [outcome, expected] of [
    [[candidate()], /1 match found/],
    [[], /No matching location found/],
    ["RATE_LIMIT", /Too many searches at once/],
    ["TIMEOUT", /timed out/],
    ["INVALID_QUERY", /between 3 and 200 characters/],
    ["NETWORK", /not been able to check this location/],
  ]) {
    const pending = deferred();
    let attempt = 0;
    const h = harness({ search: () => ++attempt === 1 ? Promise.resolve([candidate()]) : pending.promise });
    await h.search();
    h.choose();
    assert.equal(h.node("address-search-status").textContent, "");
    h.controller.refresh();
    assert.equal(h.node("address-search-status").textContent, "");
    const searching = h.search("Another public place");
    assert.match(h.node("address-search-status").textContent, /Finding matching addresses/);
    if (typeof outcome === "string") pending.reject(Object.assign(new Error("test error"), { code: outcome }));
    else pending.resolve(outcome);
    await searching;
    assert.match(h.node("address-search-status").textContent, expected);
    assert.equal(h.node("address-selection").hidden, true);
    assert.equal(h.node("address-scenarios").children.length, 0);
  }
});

test("loading state announces activity and prevents premature results", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  assert.equal(h.node("address-search-submit").textContent, "Searching…");
  assert.match(h.node("address-search-status").textContent, /Finding matching/);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, true);
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
  assert.equal(h.node("address-search-submit").textContent, "Search");
});

test("no-result search gives useful guidance and makes no flood assertion", async () => {
  const h = harness({ results: [] });
  await h.search();
  assert.match(h.node("address-search-status").textContent, /No matching location found.*street number/);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.deepEqual(h.calls.selected, []);
});

for (const [code, pattern] of [
  ["RATE_LIMIT", /Too many searches at once/],
  ["TIMEOUT", /timed out/],
  ["INVALID_QUERY", /between 3 and 200 characters/],
  ["NETWORK", /unavailable.*not been able to check this location/],
]) {
  test(`search ${code} error remains separate from geometry results`, async () => {
    const h = harness({ search: async () => { throw Object.assign(new Error("raw error <img>"), { code }); } });
    await h.search();
    assert.match(h.node("address-search-status").textContent, pattern);
    assert.doesNotMatch(h.node("address-search-status").textContent, /raw error/);
    assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
    assert.equal(h.node("address-selection").hidden, true);
    assert.equal(h.node("address-scenarios").children.length, 0);
  });
}

test("a newer search wins when an older geocoder response arrives last", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  second.resolve([candidate({ label: "New result" })]);
  await secondSearch;
  first.resolve([candidate({ label: "Stale result" })]);
  await firstSearch;
  assert.match(h.node("address-candidate-list").textContent, /New result/);
  assert.doesNotMatch(h.node("address-candidate-list").textContent, /Stale result/);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
});

test("an older completion cannot clear the busy state of a newer search", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  first.resolve([candidate({ label: "Old result" })]);
  await firstSearch;
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  assert.equal(h.node("address-candidate-list").children.length, 0);
  second.resolve([candidate()]);
  await secondSearch;
});

test("an obsolete rejection cannot replace a newer successful result", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  second.resolve([candidate()]);
  await secondSearch;
  first.reject(Object.assign(new Error("late failure"), { code: "TIMEOUT" }));
  await firstSearch;
  assert.match(h.node("address-search-status").textContent, /1 match found/);
});

test("editing the query cancels pending work and prevents stale candidates", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  h.node("address-search-input").value = "A different address";
  h.node("address-search-input").dispatch("input");
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
  assert.match(h.node("address-search-status").textContent, /Location changed.*Press Search/);
  pending.resolve([candidate({ label: "Stale result" })]);
  await searching;
  assert.equal(h.node("address-candidate-list").children.length, 0);
  assert.equal(h.node("address-selection").hidden, true);
  assert.match(h.node("address-search-status").textContent, /Location changed/);
});

test("editing an already-selected address clears the pin and scenario results", async () => {
  const h = harness();
  await h.search();
  h.choose();
  assert.equal(h.node("address-search-status").textContent, "");
  const priorClears = h.calls.clear;
  h.node("address-search-input").dispatch("input");
  assert.equal(h.calls.clear, priorClears + 1);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.equal(h.node("address-candidate-list").children.length, 0);
  assert.match(h.node("address-search-status").textContent, /Location changed.*Press Search/);
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, []);
});

test("typing with the panel closed does not open or cancel an idle search", () => {
  const h = harness();
  h.node("address-search-input").dispatch("input");
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.calls.cancel, 0);
  assert.equal(h.calls.clear, 0);
});

test("close cancels pending search and its later result cannot reopen the panel", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  h.node("address-panel-close").click();
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.node("map-layout").classList.contains("address-open"), false);
  assert.equal(h.document.activeElement, h.node("address-search-input"));
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.node("address-candidate-list").children.length, 0);
  assert.equal(h.node("address-scenarios").children.length, 0);
});

test("Escape closes from either the panel or search input and clears selected state", async () => {
  for (const origin of ["address-panel", "address-search-input"]) {
    const h = harness();
    await h.search();
    h.choose();
    let prevented = false;
    h.node(origin).dispatch("keydown", { key: "Escape", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.node("address-panel").hidden, true);
    assert.equal(h.node("address-selection").hidden, true);
    assert.equal(h.node("address-scenarios").children.length, 0);
    h.controller.refresh();
    assert.equal(h.node("address-scenarios").children.length, 0);
  }
});

test("candidate labels, kinds, metadata and selected address use literal text", async () => {
  const hostileText = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const context = dataContext();
  context.datasets[0].metadata.label = hostileText;
  context.datasets[0].metadata.description = hostileText;
  const h = harness({ context, results: [candidate({ label: hostileText, kind: hostileText })] });
  await h.search();
  assert.ok(h.node("address-candidate-list").textContent.includes(hostileText));
  assert.equal(h.node("address-candidate-list").querySelectorAll("img").length, 0);
  assert.equal(h.node("address-candidate-list").querySelectorAll("script").length, 0);
  h.choose();
  assert.equal(h.node("selected-address").textContent, hostileText);
  assert.equal(h.card(0).querySelector("h4").textContent, hostileText);
  assert.ok(h.card(0).textContent.includes(hostileText));
  assert.equal(h.card(0).querySelectorAll("script").length, 0);
});

test("both retained prototype layers independently report inside, boundary or outside", async () => {
  for (const [point, planning, demo2010] of [
    [[1, 1], "inside", "outside"],
    [[2, 5], "inside", "boundary"],
    [[0, 5], "boundary", "outside"],
    [[11, 5], "outside", "inside"],
    [[4, 5], "inside", "inside"],
    [[13, 5], "outside", "outside"],
    [[15, 15], "outside", "outside"],
  ]) {
    const h = harness({ results: [candidate({ lon: point[0], lat: point[1] })] });
    await h.search();
    h.choose();
    assert.equal(h.card(0).querySelector(".scenario-status").classList.contains(planning), true);
    assert.equal(h.card(1).querySelector(".scenario-status").classList.contains(demo2010), true);
    assert.equal(h.node("address-scenarios").children.length, 2);
  }
});

test("inside and boundary descriptions identify the displayed data without claiming verified risk", async () => {
  const h = harness({ results: [candidate({ lon: 2, lat: 5 })] });
  await h.search();
  h.choose();
  assert.equal(h.card(0).querySelector(".scenario-status").textContent, "This address is within the flood prone area");
  assert.match(h.card(0).textContent, /Planning map · not a prediction for 2100/);
  assert.doesNotMatch(h.node("address-scenarios").textContent, /Intersecting source record|Melbourne Water · study/);
  assert.equal(h.card(1).querySelector(".scenario-status").textContent, "This address is on the edge of the demo flood area");
  assert.match(h.card(1).textContent, /small change in the pin location/);
  assert.match(h.card(1).textContent, /Example only · not a record of the 2010 flood/);
  assert.match(h.node("selected-coordinate").textContent, /5\.00000, 2\.00000 \(latitude, longitude\)/);
});

test("inside statuses use the requested exact text while preserving visible data limitations", async () => {
  const h = harness();
  await h.search();
  h.choose();
  assert.deepEqual(h.node("address-scenarios").children.map((card) => card.querySelector(".scenario-status").textContent), [
    "This address is within the flood prone area",
    "This address is within the flood prone area",
  ]);
  assert.equal(h.card(0).querySelector(".scenario-data-kind").textContent, "Planning map · not a prediction for 2100");
  assert.equal(h.card(1).querySelector(".scenario-data-kind").textContent, "Example only · not a record of the 2010 flood");
  assert.match(h.card(0).textContent, /planning scenario, not an exact prediction of future flooding/);
  assert.match(h.card(1).textContent, /not an official flood model, a verified boundary, or a record of where flooding occurred in 2010/);
});

test("four initially closed topics preserve the exact requested screenshot English", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const planningDetails = h.card(0).querySelectorAll("details");
  const demoDetails = h.card(1).querySelectorAll("details");
  assert.deepEqual(planningDetails.map((details) => details.querySelector("summary").textContent), PLANNING_TOPICS);
  assert.deepEqual(demoDetails.map((details) => details.querySelector("summary").textContent), DEMO_TOPICS);
  assert.deepEqual(planningDetails.map((details) => details.getAttribute("data-topic")), ["aep", "extent", "climate"]);
  assert.equal(demoDetails[0].getAttribute("data-topic"), "extent");
  for (const details of [...planningDetails, ...demoDetails]) {
    assert.equal(details.open, false);
    assert.equal(details.children[1].className, "scenario-description");
  }
  const paragraphs = (details) => details.querySelectorAll(".scenario-description").map((node) => node.textContent);
  assert.deepEqual(paragraphs(planningDetails[0]), SCREENSHOT_PARAGRAPHS.aep);
  assert.deepEqual(paragraphs(planningDetails[1]), SCREENSHOT_PARAGRAPHS.extent2100);
  assert.deepEqual(paragraphs(planningDetails[2]), SCREENSHOT_PARAGRAPHS.climate);
  assert.deepEqual(paragraphs(demoDetails[0]), SCREENSHOT_PARAGRAPHS.extent2010);
});

test("plain-language explanations do not read or duplicate dense dataset descriptions", async () => {
  const context = dataContext();
  for (const dataset of context.datasets) {
    Object.defineProperty(dataset.metadata, "description", { get() { throw new Error("Obsolete dataset description must not be read"); } });
  }
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.card(0).querySelectorAll(".scenario-metadata").length, 0);
  assert.equal(h.card(1).querySelectorAll(".scenario-metadata").length, 0);
  assert.equal(h.card(0).querySelectorAll(".scenario-description").length, 5);
  assert.equal(h.card(1).querySelectorAll(".scenario-description").length, 1);
});

test("a polygon hole reports no intersection without claiming safety or known coverage", async () => {
  const context = dataContext();
  context.datasets[0].prepared = prepared([square(), square(2, 2, 4)]);
  const h = harness({ context, results: [candidate({ lon: 3, lat: 3 })] });
  await h.search();
  h.choose();
  assert.equal(h.card(0).querySelector(".scenario-status").textContent, "This address is outside the displayed flood-planning area");
  assert.match(h.card(0).textContent, /Being outside this area does not mean the location is safe from flooding/);
  assert.equal(h.calls.lookup.length, 2);
});

test("being outside the map catchment does not suppress either layer result or add a catchment check", async () => {
  const context = dataContext();
  context.catchment.prepared = prepared([square(-10, -10, 1)]);
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.calls.lookup.length, 2);
  assert.equal(h.calls.lookup.some(({ collection }) => collection === context.catchment.prepared), false);
  assert.match(h.card(0).textContent, /This address is within the/);
  assert.match(h.card(1).textContent, /This address is within the/);
});

test("address results do not read the removed catchment context", async () => {
  const context = dataContext();
  Object.defineProperty(context, "catchment", { get() { throw new Error("Catchment UI context must not be read"); } });
  const h = harness({ context, results: [candidate({ lon: 0, lat: 5 })] });
  await h.search();
  h.choose();
  assert.equal(h.calls.lookup.length, 2);
  assert.equal(h.card(0).querySelector(".scenario-status").classList.contains("boundary"), true);
  assert.equal(h.card(1).querySelector(".scenario-status").classList.contains("outside"), true);
});

test("loading, absent and invalid catchment data do not affect address results", async () => {
  for (const catchment of [
    { state: "loading" },
    undefined,
    { state: "loaded", prepared: {} },
  ]) {
    const context = dataContext();
    context.catchment = catchment;
    const h = harness({ context });
    await h.search();
    h.choose();
    assert.equal(h.calls.lookup.length, 2);
    assert.match(h.card(0).textContent, /This address is within the/);
  }
});

test("missing and invalid layer states show unavailable, not outside", async () => {
  for (const dataset of [undefined, { id: "legacy_2100", state: "failed" }, { id: "legacy_2100", state: "loaded" }, { id: "legacy_2100", state: "loaded", prepared: {} }]) {
    const context = dataContext();
    context.datasets = [context.datasets[1], ...(dataset ? [dataset] : [])];
    const h = harness({ context });
    await h.search();
    h.choose();
    assert.match(h.card(0).textContent, /Map data unavailable/);
    assert.match(h.card(0).textContent, /This does not mean there is no flood risk/);
    assert.doesNotMatch(h.card(0).textContent, /This address is outside the/);
    assert.equal(h.node("address-retry-data").hidden, false);
    assert.match(h.card(1).textContent, /This address is within the/);
  }
});

test("loading layer results refresh after preparation without another address search", async () => {
  const context = dataContext();
  context.datasets[0].state = "loading";
  context.datasets[0].prepared = undefined;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Loading map data/);
  assert.equal(h.node("address-retry-data").hidden, true);
  context.datasets[0].state = "loaded";
  context.datasets[0].prepared = prepared();
  h.controller.refresh();
  assert.match(h.card(0).textContent, /This address is within the/);
  assert.equal(h.calls.search.length, 1);
  assert.equal(h.calls.selected.length, 1);
});

test("retry delegates loading and refresh replaces unavailable results", async () => {
  const context = dataContext();
  context.datasets[1].state = "failed";
  context.datasets[1].prepared = undefined;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(1).textContent, /Map data unavailable/);
  h.node("address-retry-data").click();
  assert.equal(h.calls.retry, 1);
  context.datasets[1].state = "loading";
  h.controller.refresh();
  assert.match(h.card(1).textContent, /Loading map data/);
  context.datasets[1].state = "loaded";
  context.datasets[1].prepared = prepared([square(2, 2, 10)], 2);
  h.controller.refresh();
  assert.match(h.card(1).textContent, /This address is within the/);
  assert.equal(h.node("address-retry-data").hidden, true);
  assert.equal(h.calls.search.length, 1);
});

test("both retained layers are checked when hidden and archived or unrelated data is ignored", async () => {
  const context = dataContext();
  for (const dataset of context.datasets) dataset.visible = false;
  for (const id of ["baseline", "future_2100", "demo_current", "unrelated_layer"]) {
    context.datasets.push({
      id, state: "loaded", visible: true,
      get prepared() { throw new Error("Archived or unrelated geometry must not be read"); },
      get metadata() { throw new Error("Archived or unrelated metadata must not be read"); },
    });
  }
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.node("address-scenarios").children.length, 2);
  for (let index = 0; index < 2; index += 1) assert.match(h.card(index).textContent, /This address is within the/);
  assert.equal(h.calls.lookup.length, 2);
  assert.doesNotMatch(h.node("address-scenarios").textContent, /Baseline|RCP 8\.5|Official source|Current day/);
  assert.equal(h.node("address-retry-data").hidden, true);
});

test("educational topics do not read obsolete snapshot dates or model metadata", async () => {
  const context = dataContext();
  Object.defineProperty(context, "retrievedAt", { get() { throw new Error("No official snapshot dates"); } });
  for (const dataset of context.datasets) {
    for (const key of ["study_date", "modelling_scenario", "records_url"]) {
      Object.defineProperty(dataset.metadata, key, { get() { throw new Error("No official model metadata"); } });
    }
  }
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.card(0).querySelectorAll("details").length, 3);
  assert.equal(h.card(1).querySelectorAll("details").length, 1);
  assert.equal(h.calls.lookup.length, 2);
});

test("an archived current-day failure cannot create a card or orphan retry action", async () => {
  const context = dataContext();
  context.datasets.push({ id: "demo_current", state: "failed", visible: false });
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.deepEqual(h.node("address-scenarios").children.map((card) => card.querySelector("h4").textContent), LAYER_LABELS);
  assert.equal(h.node("address-retry-data").hidden, true);
  assert.doesNotMatch(h.node("address-scenarios").textContent, /Current day|Map data unavailable/);
  h.controller.refresh();
  assert.equal(h.node("address-scenarios").children.length, 2);
  assert.equal(h.node("address-retry-data").hidden, true);
  assert.deepEqual(h.calls.retry, 0);
});

test("cards omit raw data and code links and retain only the fixed reading links", async () => {
  for (const untrustedPath of [
    "javascript:alert(1)",
    "https://untrusted.example/query",
    "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11/query",
    "data/official/flood_extent_baseline.geojson",
    "data/../unverified.json",
    "data/flood_extent_2100.json?redirect=evil",
    "data/flood_extent_2100.json#untrusted",
    "//untrusted.example/data/flood_extent_2100.json",
    undefined,
  ]) {
    const context = dataContext();
    context.datasets[0].metadata.file = untrustedPath;
    context.datasets[0].metadata.source_url = untrustedPath;
    context.datasets[0].metadata.definitionSource = untrustedPath;
    for (const dataset of context.datasets) dataset.metadata.climateSource = untrustedPath;
    const h = harness({ context });
    await h.search();
    h.choose();
    for (let index = 0; index < 2; index += 1) {
      const links = h.card(index).querySelectorAll("a");
      const expectedLinks = index === 0 ? [AEP_DEFINITION, EXTENT_SOURCE, CLIMATE_SOURCE] : [];
      assert.deepEqual(links.map((link) => link.href), expectedLinks);
      assert.equal(links.length, index === 0 ? 3 : 0);
      assert.doesNotMatch(h.card(index).textContent, /Map data|How this area was created|Displayed layer data|How this layer was made/);
      if (index === 0) {
        assert.equal(links[0].textContent, AEP_DEFINITION);
        assert.equal(links[1].textContent, EXTENT_SOURCE);
        assert.equal(links[2].textContent, CLIMATE_SOURCE);
      }
      for (const link of links) {
        assert.equal(link.target, "_blank");
        assert.equal(link.rel, "noopener noreferrer");
      }
    }
  }
});

test("fixed source links stay inside their matching dropdown with no external climate CTA", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const card = h.card(0);
  const topics = card.querySelectorAll("details");
  for (const [index, details] of topics.entries()) {
    assert.equal(details.open, false);
    assert.deepEqual(details.querySelectorAll("a").map((link) => link.href), [[AEP_DEFINITION], [EXTENT_SOURCE], [CLIMATE_SOURCE]][index]);
    assert.equal(details.querySelector(".scenario-sources").querySelector("span").textContent, "For detailed information, please visit:");
    assert.equal(details.querySelector("a").textContent, details.querySelector("a").href);
  }
  assert.equal(card.children.some((child) => child.className === "scenario-sources"), false);
  assert.doesNotMatch(card.textContent, /What does this label mean\?|How does climate change influence the flood risk\?/);
  assert.equal(h.card(1).querySelectorAll("a").length, 0);
  assert.doesNotMatch(h.card(1).textContent, /How does climate change influence flooding/);
});

test("choosing another candidate clears prior selection and restores candidate focus", async () => {
  const first = candidate({ label: "First result" });
  const second = candidate({ label: "Second result", lon: 11 });
  const h = harness({ results: [first, second] });
  await h.search();
  h.choose();
  assert.equal(h.node("address-search-status").textContent, "");
  h.node("address-change-location").click();
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.equal(h.document.activeElement, h.node("address-candidate-list").querySelector("button"));
  assert.match(h.node("address-search-status").textContent, /Choose another matching location/);
  h.choose(1);
  assert.equal(h.node("address-search-status").textContent, "");
  assert.deepEqual(h.calls.selected, [first, second]);
  assert.equal(h.node("selected-address").textContent, "Second result");
  assert.match(h.card(0).textContent, /This address is outside the/);
  assert.match(h.card(1).textContent, /This address is within the/);
});

test("recenter and show-layer actions call map callbacks for the correct selection/scenario", async () => {
  const result = candidate();
  const h = harness({ results: [result] });
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, []);
  await h.search();
  h.choose();
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, [result]);
  const shown = h.card(0).querySelector("button");
  assert.equal(shown, null);
  assert.equal(h.card(0).querySelector(".scenario-actions"), null);
  assert.doesNotMatch(h.card(0).textContent, /Layer shown on map/);
  assert.deepEqual(h.calls.showLayer, []);
  const hidden = h.card(1).querySelector("button");
  assert.equal(hidden.disabled, false);
  assert.equal(hidden.textContent, "Show layer on map");
  hidden.click();
  assert.deepEqual(h.calls.showLayer, ["demo_2010"]);
  assert.equal(h.card(1).querySelector("button"), null);
  assert.equal(h.card(1).querySelector(".scenario-actions"), null);
  assert.doesNotMatch(h.card(1).textContent, /Layer shown on map/);
  assert.match(h.card(1).textContent, /This address is within the/);
  assert.equal(h.node("address-scenarios").children.length, 2);
});

test("a new search clears old selection and map pin before results arrive", async () => {
  const pending = deferred();
  let number = 0;
  const h = harness({ search: () => ++number === 1 ? Promise.resolve([candidate()]) : pending.promise });
  await h.search();
  h.choose();
  const priorClears = h.calls.clear;
  const searching = h.search("New public landmark");
  assert.equal(h.calls.clear, priorClears + 1);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  pending.resolve([candidate({ label: "New candidate" })]);
  await searching;
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.calls.selected.length, 1);
});

test("road and city candidates warn that the match is street/area-level, not a property", async () => {
  for (const kind of ["road", "street", "city", "suburb", "postcode", "administrative"]) {
    const h = harness({ results: [candidate({ kind })] });
    await h.search();
    h.choose();
    assert.match(h.node("address-precision-note").textContent, /street or area, not a specific property/);
    assert.match(h.node("address-precision-note").textContent, /Try adding a street number/);
    assert.match(h.node("address-precision-note").textContent, /check that the pin is in the right place/);
    assert.match(h.card(0).textContent, /This address is within the/);
  }
});

test("a building candidate retains the point-not-property precision qualification", async () => {
  const h = harness({ results: [candidate({ kind: "building" })] });
  await h.search();
  h.choose();
  assert.match(h.node("address-precision-note").textContent, /approximate location, not the whole property or its entrance/);
  assert.match(h.node("address-precision-note").textContent, /Check that the pin is in the right place/);
  assert.doesNotMatch(h.node("address-precision-note").textContent, /Street\/area-level/);
});

test("same-name candidates include distinct coordinates and retain their distinct selection points", async () => {
  const first = candidate({ label: "Same place name", kind: "building", lat: -37.815123, lon: 144.963456 });
  const second = candidate({ label: "Same place name", kind: "building", lat: -37.811234, lon: 144.971234 });
  const h = harness({ results: [first, second] });
  await h.search();
  const candidates = h.node("address-candidate-list").children;
  assert.match(candidates[0].textContent, /Same place name/);
  assert.match(candidates[1].textContent, /Same place name/);
  assert.match(candidates[0].textContent, /building · -37\.81512, 144\.96346 · Select/);
  assert.match(candidates[1].textContent, /building · -37\.81123, 144\.97123 · Select/);
  assert.notEqual(candidates[0].textContent, candidates[1].textContent);
  h.choose(1);
  assert.deepEqual(h.calls.selected, [second]);
  assert.match(h.node("selected-coordinate").textContent, /-37\.81123, 144\.97123/);
});

test("all topic dropdowns preserve independent layer-and-topic state across refresh and visibility changes", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const topics = (index) => h.card(index).querySelectorAll("details");
  const states = () => [topics(0).map((topic) => topic.open), topics(1).map((topic) => topic.open)];
  const toggle = (layer, topic, open) => {
    const details = topics(layer)[topic];
    details.open = open;
    details.dispatch("toggle");
  };
  assert.deepEqual(states(), [[false, false, false], [false]]);
  toggle(0, 1, true);
  h.controller.refresh();
  assert.deepEqual(states(), [[false, true, false], [false]], "The two extent topics must not share state");
  toggle(0, 0, true);
  toggle(0, 2, true);
  toggle(1, 0, true);
  h.controller.refresh();
  assert.deepEqual(states(), [[true, true, true], [true]], "Topics may all be open without closing each other");
  toggle(0, 0, false);
  toggle(0, 1, false);
  h.card(1).querySelector("button").click();
  assert.deepEqual(states(), [[false, false, true], [true]], "Showing a hidden layer must not clobber any topic state");
  assert.equal(h.card(1).querySelector("button"), null);
  h.context.datasets[0].visible = false;
  h.controller.refresh();
  assert.deepEqual(states(), [[false, false, true], [true]]);
  h.card(0).querySelector("button").click();
  assert.deepEqual(states(), [[false, false, true], [true]]);
});

test("queued toggles from replaced cards cannot overwrite current dropdown state", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const obsolete = h.card(0).querySelectorAll("details");
  obsolete[1].open = true;
  obsolete[1].dispatch("toggle");
  h.controller.refresh();
  const current = h.card(0).querySelectorAll("details");
  current[1].open = false;
  current[1].dispatch("toggle");
  current[2].open = true;
  current[2].dispatch("toggle");
  obsolete[1].dispatch("toggle");
  obsolete[2].open = false;
  obsolete[2].dispatch("toggle");
  h.controller.refresh();
  assert.deepEqual(h.card(0).querySelectorAll("details").map((topic) => topic.open), [false, false, true]);
  assert.equal(h.card(1).querySelector("details").open, false);
});

test("failure and loading guidance stays visible while topic state survives retry and successful load", async () => {
  const context = dataContext();
  context.datasets[0].state = "failed";
  context.datasets[0].prepared = undefined;
  const h = harness({ context });
  await h.search();
  h.choose();
  const topic = h.card(0).querySelectorAll("details")[2];
  topic.open = true;
  topic.dispatch("toggle");
  assert.match(h.card(0).children.find((child) => child.className === "scenario-description").textContent, /map data is missing or could not be read/);
  assert.equal(h.card(0).querySelector("button"), null);
  h.node("address-retry-data").click();
  assert.equal(h.calls.retry, 1);
  context.datasets[0].state = "loading";
  h.controller.refresh();
  assert.match(h.card(0).children.find((child) => child.className === "scenario-description").textContent, /Your result will appear/);
  assert.deepEqual(h.card(0).querySelectorAll("details").map((details) => details.open), [false, false, true]);
  context.datasets[0].state = "loaded";
  context.datasets[0].prepared = prepared();
  h.controller.refresh();
  assert.equal(h.card(0).querySelector(".scenario-status").textContent, "This address is within the flood prone area");
  assert.equal(h.card(0).children.some((child) => child.className === "scenario-description"), false);
  assert.deepEqual(h.card(0).querySelectorAll("details").map((details) => details.open), [false, false, true]);
  assert.equal(h.node("address-retry-data").hidden, true);
});

test("an invalid prepared layer handle cannot offer a show-layer action", async () => {
  const context = dataContext();
  context.datasets[0].prepared = {};
  context.datasets[0].visible = false;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Map data unavailable/);
  assert.equal(h.card(0).querySelector("button"), null);
  assert.doesNotMatch(h.card(0).textContent, /Show layer on map|Layer shown on map/);
  assert.equal(h.node("address-retry-data").hidden, false);
  assert.equal(h.card(1).querySelector("button").textContent, "Show layer on map");
});

test("source URLs with embedded credentials cannot replace the fixed definition link", async () => {
  for (const credentials of ["username:password", "username", ":password", "user%3Aname:pass%40word"]) {
    const context = dataContext();
    context.datasets[0].metadata.source_url = `https://${credentials}@spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11/query`;
    const h = harness({ context });
    await h.search();
    h.choose();
    const link = h.card(0).querySelector("a");
    assert.equal(link.href, AEP_DEFINITION);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
});

test("a fresh search resets stale panel scroll as soon as the panel opens", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  h.node("address-panel").scrollTop = 420;
  const searching = h.search();
  assert.equal(h.node("address-panel").hidden, false);
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").scrollTop, 0);
});

test("selecting a candidate resets stale panel scroll and focuses without scrolling", async () => {
  const h = harness();
  await h.search();
  h.node("address-panel").scrollTop = 300;
  h.choose();
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.document.activeElement, h.node("selected-address"));
  assert.deepEqual(h.node("selected-address").focusOptions, { preventScroll: true });
});

test("choosing another result resets stale panel scroll and preserves non-scrolling focus", async () => {
  const h = harness({ results: [candidate(), candidate({ label: "Second result", lon: 11 })] });
  await h.search();
  h.choose();
  h.node("address-panel").scrollTop = 510;
  h.node("address-change-location").click();
  const firstCandidate = h.node("address-candidate-list").querySelector("button");
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.document.activeElement, firstCandidate);
  assert.deepEqual(firstCandidate.focusOptions, { preventScroll: true });
});

test("refresh alone preserves the user's current panel scroll position", async () => {
  const h = harness();
  await h.search();
  h.choose();
  h.node("address-panel").scrollTop = 275;
  const activeElement = h.document.activeElement;
  h.controller.refresh();
  assert.equal(h.node("address-panel").scrollTop, 275);
  assert.equal(h.document.activeElement, activeElement);
  assert.match(h.card(0).textContent, /This address is within the/);
});

test("exact original layer titles and result order are stable even when dataset input is reversed", async () => {
  const context = dataContext();
  context.datasets.reverse();
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.deepEqual(h.node("address-scenarios").children.map((card) => card.querySelector("h4").textContent), LAYER_LABELS);
  for (const dataset of context.datasets) delete dataset.metadata;
  h.controller.refresh();
  assert.deepEqual(h.node("address-scenarios").children.map((card) => card.querySelector("h4").textContent), LAYER_LABELS);
});

test("planning and synthetic provenance warnings remain visible outside collapsed explanations", async () => {
  const h = harness();
  await h.search();
  h.choose();
  for (let index = 0; index < 2; index += 1) {
    const card = h.card(index);
    const badge = card.querySelector(".scenario-data-kind");
    const topics = card.querySelectorAll("details");
    assert.equal(card.children.includes(badge), true);
    assert.equal(badge.hidden, false);
    for (const details of topics) {
      assert.equal(details.open, false);
      assert.equal(details.querySelector(".scenario-data-kind"), null);
    }
    assert.equal(badge.textContent, index === 0
      ? "Planning map · not a prediction for 2100"
      : "Example only · not a record of the 2010 flood");
    assert.deepEqual(topics[index === 0 ? 1 : 0].querySelectorAll(".scenario-description").map((node) => node.textContent), index === 0 ? SCREENSHOT_PARAGRAPHS.extent2100 : SCREENSHOT_PARAGRAPHS.extent2010);
  }
});

test("provenance badges remain visible for missing or loading prototype layers", async () => {
  const context = dataContext();
  context.datasets = [{ id: "demo_2010", state: "loading" }];
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Map data unavailable/);
  assert.match(h.card(1).textContent, /Loading map data/);
  assert.equal(h.node("address-scenarios").children.length, 2);
  for (let index = 0; index < 2; index += 1) {
    const badge = h.card(index).querySelector(".scenario-data-kind");
    assert.equal(h.card(index).children.includes(badge), true);
    assert.equal(badge.hidden, false);
  }
});
