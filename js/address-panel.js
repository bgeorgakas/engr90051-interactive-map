/* Address lookup UI. Geometry-only checks against the two retained prototype layers. */
(function (root) {
  "use strict";
  const LAYERS = {
    legacy_2100: {
      label: "Flood Extent 2100 — 1% AEP (climate change scenario)",
      file: "data/flood_extent_2100.json",
      results: {
        inside: ["This address has been identified as at risk of flooding", ""],
        boundary: ["This address is on the edge of the area identified as at risk of flooding", ""],
        outside: ["This address has not been identified as at risk of flooding", ""],
      },
      topics: [
        {
          id: "aep",
          title: "What does 1% AEP mean?",
          paragraphs: [
            "1% AEP “refers to the probability or risk of a rainfall event of a given magnitude (intensity and duration) occurring or being exceeded in any given year. A 90% AEP event has a high probability of occurring or being exceeded; it would occur quite often and would be a relatively minor rainfall event. A 1% AEP event has a low probability of occurrence or being exceeded; it would be rare but it would be likely to cause extensive damage.” [3]",
          ],
          // Cited by catalogue marker so the reference text is defined once (the Water Technology report).
          references: ["[3]"],
        },
        {
          id: "extent",
          title: "What does 2100 flood extent represent?",
          paragraphs: [
            "The 2100 flood extent shows the area that may be subject to inundation from a 1% AEP flood event in the year 2100, taking into account the effects of climate change",
          ],
          source: {
            url: "https://participate.melbourne.vic.gov.au/amendment-c384",
          },
        },
        {
          id: "climate",
          title: "How does climate change influence flooding?",
          paragraphs: [
            "Climate change increases the likelihood and severity of flooding due primarily to increased rainfall intensity and rising sea levels. The 2100 flood extent is based on a climate change scenario that assumes an 18.5% increase in rainfall intensity by the year 2100 [1].",
          ],
          references: ["[1]"],
        },
      ],
    },
    demo_2010: {
      label: "Flood Extent 2010 (example only)",
      file: "data/flood_extent_2010.json",
      // Example geometry: the "In this example layer" wording keeps results from reading as a 2010 record.
      results: {
        inside: ["In this example layer, this address falls within the 2010 flood extent", ""],
        boundary: ["In this example layer, this address is on the edge of the 2010 flood extent", ""],
        outside: ["In this example layer, this address falls outside the 2010 flood extent", ""],
      },
      // Explained by the card's "About this data" dropdown.
      topics: [],
    },
  };

  const SHARED_RESULTS = {
    out_of_area: ["This address is outside the area covered by this map", ""],
    unavailable: ["Map data unavailable", "We could not check this location because the map data is missing or could not be read. This does not mean there is no flood risk."],
    loading: ["Loading map data…", "Your result will appear when this part of the map finishes loading."],
  };

  function create(options) {
    const doc = options.document || root.document;
    const lookup = options.lookupPoint || root.AddressLookup.lookupPoint;
    // Descriptions and references come from the fixed catalogue, not from loaded data.
    const catalogue = options.catalogue || root.PrototypeData?.DATASETS || [];
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

    function safeLink(href) {
      try {
        const url = new URL(href);
        return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
      } catch (_) { return null; }
    }

    function topicDetails(card, key, title) {
      const details = element("details", undefined, "scenario-details");
      details.open = expandedTopics.has(key);
      details.addEventListener("toggle", () => {
        // Ignore queued events from cards replaced by a later refresh.
        if (!scenarios.contains(card)) return;
        if (details.open) expandedTopics.add(key);
        else expandedTopics.delete(key);
      });
      details.appendChild(element("summary", title));
      return details;
    }

    function aboutDetails(card, id) {
      const entry = catalogue.find((dataset) => dataset.id === id);
      if (!entry?.description) return null;
      const details = topicDetails(card, `${id}:about`, "About this data");
      details.setAttribute("data-topic", "about");
      details.appendChild(element("p", entry.description, "scenario-description"));
      const list = referenceList(entry.references);
      if (list) details.appendChild(list);
      return details;
    }

    function referenceList(references = []) {
      const list = element("ul", undefined, "scenario-references");
      for (const reference of references) {
        const href = safeLink(reference.url);
        if (!href) continue;
        const item = element("li", `${reference.marker} ${reference.text} `);
        item.appendChild(localLink("Available here", href));
        list.appendChild(item);
      }
      return list.children.length ? list : null;
    }

    function catalogueReferences(markers = []) {
      const all = catalogue.flatMap((dataset) => dataset.references || []);
      return markers.map((marker) => all.find((reference) => reference.marker === marker)).filter(Boolean);
    }

    // Outside the catchment there is no flood data to compare against. If the
    // catchment is unavailable, fall back to the layer results alone.
    function outsideMappedArea(point, catchment) {
      if (catchment?.state !== "loaded" || !catchment.prepared) return false;
      try { return lookup(point, catchment.prepared).relation === "outside"; } catch (_) { return false; }
    }

    function refresh() {
      if (!selection || panel.hidden) return;
      const context = options.getData();
      const point = [selection.lon, selection.lat];
      node("selected-address").textContent = selection.label;
      scenarios.replaceChildren();
      const outOfArea = outsideMappedArea(point, context.catchment);
      let hasFailedData = false;
      for (const id of Object.keys(LAYERS)) {
        const layer = LAYERS[id];
        const dataset = context.datasets.find((entry) => entry.id === id) || { id, state: "failed" };
        const metadata = dataset.metadata;
        const card = element("section", undefined, "scenario-card");
        card.appendChild(element("h4", metadata?.label || layer.label));
        let relation = dataset.state === "loading" ? "loading" : "unavailable";
        if (dataset.state === "loaded" && dataset.prepared) {
          try {
            const result = lookup(point, dataset.prepared);
            relation = result.relation;
          } catch (_) { relation = "unavailable"; }
        }
        if (outOfArea && ["inside", "boundary", "outside"].includes(relation)) relation = "out_of_area";
        const messages = { ...layer.results, ...SHARED_RESULTS };
        if (!messages[relation]) relation = "unavailable";
        const [heading, description] = messages[relation];
        card.appendChild(element("p", heading, `scenario-status ${relation}`));
        // Result guidance stays visible; educational topics expand independently.
        if (description) card.appendChild(element("p", description, "scenario-description"));
        for (const topic of layer.topics) {
          const details = topicDetails(card, `${id}:${topic.id}`, topic.title);
          details.setAttribute("data-topic", topic.id);
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
          const references = referenceList(catalogueReferences(topic.references));
          if (references) details.appendChild(references);
          card.appendChild(details);
        }
        const about = aboutDetails(card, id);
        if (about) card.appendChild(about);
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
