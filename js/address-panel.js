/* Address lookup UI. Geometry-only checks against the two retained prototype layers. */
(function (root) {
  "use strict";
  const LAYERS = {
    legacy_2100: {
      label: "2100 — 1% AEP (climate change)",
      file: "data/flood_extent_2100.json",
      badge: "Planning map · not a prediction for 2100",
      areaName: "displayed flood-planning area",
      kind: "planning_overlay",
      topics: [
        {
          id: "aep",
          title: "What does 1% AEP mean?",
          paragraphs: [
            "A 1% annual exceedance probability (AEP) means a flood of a particular size that has a 1% chance of occurring in any year.",
            "You may hear this called a “1 in 100-year flood”, but it does not mean it happens only once every 100 years. These floods can occur close together, even in consecutive years. Therefore, a recent flood does not mean your area is safe from another.",
            "Flood maps show areas that could be affected, but cannot tell you when flooding will happen. Knowing your risk, preparing a flood plan and following official warnings can help you stay safe.",
          ],
          source: {
            url: "https://www.melbournewater.com.au/about/publications/news/what-1-100-year-flood-event",
          },
        },
        {
          id: "extent",
          title: "What does 2100 flood extent represent?",
          paragraphs: [
            "The 2100 flood extent shows areas that may be affected by a severe flood with a 1% chance of occurring in any year. It includes flooding associated with both Melbourne Water’s main drains and the City of Melbourne’s council drains, assuming rainfall intensity increases by 18.5% due to climate change by 2100. It is a planning scenario, not an exact prediction of future flooding.",
          ],
          source: {
            url: "https://participate.melbourne.vic.gov.au/amendment-c384",
          },
        },
        {
          id: "climate",
          title: "How does climate change influence flooding?",
          paragraphs: [
            "Climate change can make flooding more likely and more severe. As the air gets warmer, it can hold more water. This can lead to heavier rain falling in a shorter time. When too much rain falls quickly, drains and waterways may not be able to carry it away, causing water to build up in streets and low-lying areas. Warmer conditions can also give storms more energy and produce heavier rainfall. This means floods may happen more often, spread further and cause damage to homes, roads and services. Understanding this risk can help communities prepare and stay safer during severe weather.",
          ],
          source: {
            url: "https://www.climatecouncil.org.au/resources/climate-change-floods/",
          },
        },
      ],
    },
    demo_2010: {
      label: "2010 flood event (indicative)",
      file: "data/flood_extent_2010.json",
      badge: "Example only · not a record of the 2010 flood",
      areaName: "demo flood area",
      kind: "synthetic_demo",
      topics: [
        {
          id: "extent",
          title: "What does 2010 flood extent represent?",
          paragraphs: [
            "The 2010 flood extent is an indicative map created for this website by trimming the larger 2100 flood extent. It provides a visual comparison showing how the mapped flood area could expand under projected climate conditions by 2100. However, it is not an official flood model, a verified boundary, or a record of where flooding occurred in 2010. Properties within the indicative area may not flood during every severe storm, while properties outside it may still be affected. The map should therefore be used only to support community awareness and discussion, not for property-specific assessment, planning, insurance, or emergency decisions.",
          ],
        },
      ],
    },
  };

  function create(options) {
    const doc = options.document || root.document;
    const lookup = options.lookupPoint || root.AddressLookup.lookupPoint;
    const node = (id) => doc.getElementById(id);
    const panel = node("address-panel");
    const input = node("address-search-input");
    const submit = node("address-search-submit");
    const status = node("address-search-status");
    const candidatesNode = node("address-candidates");
    const candidateList = node("address-candidate-list");
    const selectionNode = node("address-selection");
    const scenarios = node("address-scenarios");
    let selection = null;
    let candidates = [];
    let generation = 0;
    let searching = false;
    const expandedTopics = new Set();

    function element(tag, text, className) {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (className) el.className = className;
      return el;
    }

    function busy(value) {
      searching = value;
      panel.setAttribute("aria-busy", String(value));
      submit.textContent = value ? "Searching…" : "Search";
    }

    function open() {
      panel.hidden = false;
      panel.scrollTop = 0;
      node("map-layout").classList.add("address-open");
      options.onOpen?.();
    }

    function resetSelection() {
      selection = null;
      selectionNode.hidden = true;
      scenarios.replaceChildren();
      options.onClear?.();
    }

    function close() {
      generation += 1;
      options.searchClient.cancel();
      busy(false);
      resetSelection();
      candidates = [];
      candidateList.replaceChildren();
      candidatesNode.hidden = true;
      panel.hidden = true;
      node("map-layout").classList.remove("address-open");
      input.focus();
    }

    function localLink(text, href) {
      const link = element("a", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }

    function refresh() {
      if (!selection || panel.hidden) return;
      const context = options.getData();
      const point = [selection.lon, selection.lat];
      node("selected-address").textContent = selection.label;
      node("selected-coordinate").textContent = `Map pin: ${selection.lat.toFixed(5)}, ${selection.lon.toFixed(5)} (latitude, longitude)`;
      const broadMatch = ["road", "street", "suburb", "neighbourhood", "quarter", "city", "town", "village", "municipality", "county", "state", "country", "postcode", "administrative"].includes(selection.kind);
      node("address-precision-note").textContent = broadMatch
        ? "This pin marks a street or area, not a specific property. Try adding a street number, and check that the pin is in the right place."
        : "Check that the pin is in the right place. It marks an approximate location, not the whole property or its entrance.";
      scenarios.replaceChildren();
      let hasFailedData = false;
      for (const id of Object.keys(LAYERS)) {
        const layer = LAYERS[id];
        const dataset = context.datasets.find((entry) => entry.id === id) || { id, state: "failed" };
        const metadata = dataset.metadata;
        const card = element("section", undefined, "scenario-card");
        card.appendChild(element("h4", metadata?.label || layer.label));
        // Keep provenance visible even while explanation details are collapsed.
        card.appendChild(element("p", layer.badge, `scenario-data-kind ${layer.kind}`));
        let relation = dataset.state === "loading" ? "loading" : "unavailable";
        if (dataset.state === "loaded" && dataset.prepared) {
          try {
            const result = lookup(point, dataset.prepared);
            relation = result.relation;
          } catch (_) { relation = "unavailable"; }
        }
        const messages = {
          inside: ["This address is within the flood prone area", ""],
          boundary: [`This address is on the edge of the ${layer.areaName}`, "A small change in the pin location could change this result. Check that the pin matches your location."],
          outside: [`This address is outside the ${layer.areaName}`, "Being outside this area does not mean the location is safe from flooding."],
          unavailable: ["Map data unavailable", "We could not check this location because the map data is missing or could not be read. This does not mean there is no flood risk."],
          loading: ["Loading map data…", "Your result will appear when this part of the map finishes loading."],
        };
        if (!messages[relation]) relation = "unavailable";
        const [heading, description] = messages[relation];
        card.appendChild(element("p", heading, `scenario-status ${relation}`));
        // Result guidance stays visible; educational topics expand independently.
        if (description) card.appendChild(element("p", description, "scenario-description"));
        for (const topic of layer.topics) {
          const key = `${id}:${topic.id}`;
          const details = element("details", undefined, "scenario-details");
          details.setAttribute("data-topic", topic.id);
          details.open = expandedTopics.has(key);
          details.addEventListener("toggle", () => {
            // Ignore queued events from cards replaced by a later refresh.
            if (!scenarios.contains(card)) return;
            if (details.open) expandedTopics.add(key);
            else expandedTopics.delete(key);
          });
          details.appendChild(element("summary", topic.title));
          for (const paragraph of topic.paragraphs) {
            details.appendChild(element("p", paragraph, "scenario-description"));
          }
          // Only use the supplied fixed links, never dataset-provided URLs.
          if (topic.source) {
            const sources = element("p", undefined, "scenario-sources");
            sources.appendChild(element("span", "For detailed information, please visit:"));
            sources.appendChild(localLink(topic.source.url, topic.source.url));
            details.appendChild(sources);
          }
          card.appendChild(details);
        }
        if (!dataset.visible && ["inside", "boundary", "outside"].includes(relation)) {
          const actions = element("div", undefined, "scenario-actions");
          const show = element("button", "Show layer on map");
          show.type = "button";
          show.addEventListener("click", () => { options.onShowLayer?.(id); refresh(); });
          actions.appendChild(show);
          card.appendChild(actions);
        }
        scenarios.appendChild(card);
        if (relation === "unavailable") hasFailedData = true;
      }
      node("address-retry-data").hidden = !hasFailedData;
    }

    function select(result) {
      selection = result;
      candidatesNode.hidden = true;
      selectionNode.hidden = false;
      status.textContent = "";
      refresh();
      options.onSelect?.(result);
      node("selected-address").focus({ preventScroll: true });
      panel.scrollTop = 0;
    }

    function showCandidates() {
      candidateList.replaceChildren();
      candidatesNode.hidden = candidates.length === 0;
      for (const result of candidates) {
        const item = element("li");
        const button = element("button", undefined, "address-candidate");
        button.type = "button";
        button.appendChild(element("span", result.label));
        button.appendChild(element("span", `${result.kind || "location"} · ${result.lat.toFixed(5)}, ${result.lon.toFixed(5)} · Select →`, "candidate-kind"));
        button.addEventListener("click", () => select(result));
        item.appendChild(button);
        candidateList.appendChild(item);
      }
    }

    async function search(event) {
      event?.preventDefault();
      const request = ++generation;
      options.searchClient.cancel();
      resetSelection();
      candidates = [];
      showCandidates();
      open();
      busy(true);
      status.textContent = "Finding matching addresses and places…";
      try {
        const results = await options.searchClient.search(input.value, { viewbox: options.getViewbox?.() });
        if (request !== generation) return;
        candidates = results;
        showCandidates();
        status.textContent = results.length
          ? `${results.length} match${results.length === 1 ? "" : "es"} found. Choose your location below.`
          : "No matching location found. Try a street number, street name and Melbourne, or a nearby public landmark.";
      } catch (error) {
        if (request !== generation || error.code === "CANCELLED") return;
        const messages = {
          RATE_LIMIT: "Too many searches at once. Please wait a moment and try again.",
          TIMEOUT: "Address search timed out. Check your connection and try again.",
          INVALID_QUERY: "Enter between 3 and 200 characters, such as a public address or landmark in Melbourne.",
        };
        status.textContent = messages[error.code] || "Address search is unavailable. Please try again later. We have not been able to check this location.";
      } finally {
        if (request === generation) busy(false);
      }
    }

    node("address-search").addEventListener("submit", search);
    input.addEventListener("input", () => {
      if (panel.hidden && !searching) return;
      generation += 1;
      options.searchClient.cancel();
      busy(false);
      resetSelection();
      candidates = [];
      showCandidates();
      status.textContent = "Location changed. Press Search to look up the new address.";
    });
    node("address-panel-close").addEventListener("click", close);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); close(); } });
    node("address-change-location").addEventListener("click", () => {
      resetSelection();
      showCandidates();
      status.textContent = "Choose another matching location below, or enter a new search.";
      candidateList.querySelector("button")?.focus({ preventScroll: true });
      panel.scrollTop = 0;
    });
    node("address-recentre").addEventListener("click", () => { if (selection) options.onRecenter?.(selection); });
    node("address-retry-data").addEventListener("click", () => { options.onRetry?.(); });
    return { refresh, close };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AddressPanel = api;
})(typeof window === "undefined" ? globalThis : window);
