const map = L.map("map").setView([-37.811, 144.962], 15);

const stadiaBase = L.tileLayer("https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=b73e5bd5-ccb6-4b14-92c5-69cd89becd8b", {
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; OpenStreetMap contributors',
}).addTo(map);

const baseLayers = {
  "Stadia Alidade Smooth": stadiaBase,
};

const layerControl = L.control.layers(baseLayers, {}, { collapsed: true }).addTo(map);
if (map.getSize().x > 640) layerControl.expand();

let addressPanel = null;
let selectedLocation = null;
let searchMarker = null;
let catchmentBounds = null;
let catchmentPrepared = null;
let catchmentState = "loading";
const prototypePrepared = new Map();

const mapLoadWarning = document.getElementById("map-load-warning");
const failedOptionalLayers = new Set();

function reportLayerFailure(name) {
  failedOptionalLayers.add(name);
  renderOptionalFailures();
}

function renderOptionalFailures() {
  mapLoadWarning.textContent = `Could not load: ${[...failedOptionalLayers].join(", ")}. Missing data does not mean no flooding.`;
  mapLoadWarning.hidden = failedOptionalLayers.size === 0;
  document.getElementById("retry-map-content").hidden =
    !["Flood infrastructure", "Historic flood stories"].some((name) => failedOptionalLayers.has(name));
}

function clearLayerFailure(name) {
  failedOptionalLayers.delete(name);
  renderOptionalFailures();
}

function fetchOverlay(url, name, style) {
  return FloodData.fetchJSON(url)
    .then((geojson) => {
      if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) {
        throw new Error("Empty or invalid map layer");
      }
      return geojson;
    })
    .then((geojson) => ({ name, geojson, layer: L.geoJSON(geojson, { style }) }))
    .catch((err) => {
      console.error(`Failed to load overlay "${name}" from ${url}`, err);
      reportLayerFailure(name);
      return null;
    });
}

function addOverlay(overlay, enabled = true) {
  if (!overlay) return null;
  if (enabled) overlay.layer.addTo(map);
  layerControl.addOverlay(overlay.layer, overlay.name);
  return overlay.layer;
}

const catchmentLayer = fetchOverlay("data/catchment.json", "Elizabeth Street catchment", {
  color: "#111827",
  weight: 2,
  fill: false,
  dashArray: "6 4",
}).then((overlay) => {
  if (!overlay) {
    catchmentState = "failed";
    addressPanel?.refresh();
    return null;
  }
  try {
    catchmentPrepared = AddressLookup.prepareCollection(overlay.geojson);
    catchmentState = "loaded";
  } catch (err) {
    catchmentState = "failed";
    console.error("Catchment geometry cannot be used for address lookup", err);
  }
  addressPanel?.refresh();
  return addOverlay(overlay);
});

// Retain the 2100/2010 prototype layers; current-day is archived, not loaded.
// Their legacy names are retained; the persistent notices explain their data types.
const prototypeDatasets = PrototypeData.DATASETS;
const prototypeStyles = [
  { color: "#0284c7", weight: 1, fillColor: "#7dd3fc", fillOpacity: 0.35 },
  { color: "#7c3aed", weight: 1, fillColor: "#a78bfa", fillOpacity: 0.4 },
];
prototypeDatasets.forEach((dataset, index) => {
  map.createPane(dataset.id);
  map.getPane(dataset.id).style.zIndex = 410 + index * 10;
});

const layerStatus = document.getElementById("layer-status");
const retryLayerData = document.getElementById("retry-layer-data");
const datasetSources = document.getElementById("dataset-sources");
const prototypeLayers = new Map();
const prototypeStates = new Map();
let loadingPrototypeData = false;

function sourceLink(label, href) {
  const a = document.createElement("a");
  a.textContent = label;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// Only failures are listed, so the panel stays limited to sources and limitations.
function updateLayerStatus() {
  layerStatus.replaceChildren();
  for (const { id, label } of prototypeDatasets) {
    if (prototypeStates.get(id) !== "failed") continue;
    const line = document.createElement("p");
    line.textContent = `${label}: failed to load — not evidence of no flooding`;
    line.className = "data-error";
    layerStatus.appendChild(line);
  }
  layerStatus.hidden = layerStatus.children.length === 0;
  addressPanel?.refresh();
}

// Fixed catalogue citations, numbered to match the [n] markers in the description.
function referenceList(dataset) {
  const list = document.createElement("ol");
  list.className = "dataset-references";
  (dataset.references || []).forEach(({ marker, text, url }) => {
    const item = document.createElement("li");
    item.appendChild(document.createTextNode(`${marker} ${text} `));
    item.appendChild(sourceLink("Available here", url));
    list.appendChild(item);
  });
  return list;
}

function renderSources() {
  datasetSources.replaceChildren();
  prototypeDatasets.forEach((dataset) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = dataset.label;
    section.appendChild(heading);
    const text = document.createElement("p");
    text.textContent = dataset.description;
    section.appendChild(text);
    if (dataset.references?.length) section.appendChild(referenceList(dataset));
    datasetSources.appendChild(section);
  });
}

function featureDetails(dataset) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = dataset.label;
  container.appendChild(heading);
  const p = document.createElement("p");
  p.textContent = dataset.description;
  container.appendChild(p);
  if (dataset.references?.length) container.appendChild(referenceList(dataset));
  return container;
}

function syncPrototypeControls() {
  for (const layer of prototypeLayers.values()) layerControl.removeLayer(layer);
  for (const dataset of prototypeDatasets) {
    const layer = prototypeLayers.get(dataset.id);
    if (layer) layerControl.addOverlay(layer, dataset.label);
  }
}

async function loadPrototypeData() {
  if (loadingPrototypeData) return;
  loadingPrototypeData = true;
  retryLayerData.hidden = true;
  for (const { id } of prototypeDatasets) {
    if (!prototypeLayers.has(id)) prototypeStates.set(id, "loading");
  }
  updateLayerStatus();
  try {
    await Promise.all(prototypeDatasets.map(async (dataset, index) => {
      if (prototypeLayers.has(dataset.id)) return;
      try {
        const geojson = PrototypeData.validateExtent(await FloodData.fetchJSON(dataset.file), dataset);
        const prepared = AddressLookup.prepareCollection(geojson);
        const layer = L.geoJSON(geojson, {
          pane: dataset.id,
          style: prototypeStyles[index],
          onEachFeature: (_feature, featureLayer) => featureLayer.bindPopup(featureDetails(dataset)),
        });
        prototypeLayers.set(dataset.id, layer);
        prototypePrepared.set(dataset.id, prepared);
        prototypeStates.set(dataset.id, "loaded");
        syncPrototypeControls();
        // Only Flood Extent 2100 starts visible; the others are opt-in from the layer control.
        if (dataset.id === "legacy_2100") layer.addTo(map);
      } catch (err) {
        console.error(`Prototype layer ${dataset.id} failed`, err);
        prototypeStates.set(dataset.id, "failed");
      }
      updateLayerStatus();
    }));
  } finally {
    loadingPrototypeData = false;
    retryLayerData.hidden = ![...prototypeStates.values()].includes("failed");
  }
}

renderSources();
map.on("overlayadd overlayremove", updateLayerStatus);
retryLayerData.addEventListener("click", loadPrototypeData);
loadPrototypeData();

catchmentLayer.then((layer) => {
  if (layer) {
    catchmentBounds = layer.getBounds();
    if (!selectedLocation) map.fitBounds(catchmentBounds);
  }
});

// The endpoint is server-hosted configuration, so it can be replaced/disabled
// without changing the browser module. No geocoding occurs until submission.
let searchClient = null;
let searchGeneration = 0;
const searchClientReady = FloodData.fetchJSON("data/search-config.json")
  .then((config) => {
    if (config.enabled !== true) return null;
    if (typeof config.endpoint !== "string" || !config.endpoint.trim()) return null;
    searchClient = AddressSearch.createClient({
      endpoint: config.endpoint,
      minIntervalMs: config.minIntervalMs,
      timeoutMs: config.timeoutMs,
    });
    return searchClient;
  })
  .catch(() => null);

function recenterAddress(result) {
  map.setView([result.lat, result.lon], 17, { animate: false });
  // Keep the pin in the unobscured map area, including the mobile bottom sheet.
  const size = map.getSize();
  const panel = document.getElementById("address-panel");
  if (!panel.hidden) {
    if (size.x <= 640) map.panBy([0, panel.offsetHeight / 2], { animate: false });
    else map.panBy([panel.offsetWidth / 2, 0], { animate: false });
  }
}

addressPanel = AddressPanel.create({
  catalogue: prototypeDatasets,
  searchClient: {
    cancel() { searchGeneration += 1; searchClient?.cancel(); },
    async search(query, options) {
      const request = ++searchGeneration;
      const client = await searchClientReady;
      if (request !== searchGeneration) throw Object.assign(new Error("Search cancelled"), { code: "CANCELLED" });
      if (!client) throw Object.assign(new Error("Search unavailable"), { code: "REQUEST_FAILED" });
      return client.search(query, options);
    },
  },
  getViewbox: () => catchmentBounds
    ? [catchmentBounds.getWest(), catchmentBounds.getNorth(), catchmentBounds.getEast(), catchmentBounds.getSouth()]
    : undefined,
  getData: () => ({
    catchment: { state: catchmentState, prepared: catchmentPrepared },
    datasets: prototypeDatasets.map((metadata) => ({
      id: metadata.id,
      state: prototypeStates.get(metadata.id) || "loading",
      metadata,
      prepared: prototypePrepared.get(metadata.id),
      visible: prototypeLayers.has(metadata.id) && map.hasLayer(prototypeLayers.get(metadata.id)),
    })),
  }),
  onOpen() {
    closeStoryPanel();
    if (map.getSize().x <= 640) layerControl.collapse();
  },
  onClear() {
    selectedLocation = null;
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = null;
  },
  onSelect(result) {
    selectedLocation = result;
    if (searchMarker) map.removeLayer(searchMarker);
    const popup = document.createElement("div");
    popup.textContent = "Selected geocoded point. See Address lookup for prototype layer matches, not a flood-risk assessment.";
    searchMarker = L.marker([result.lat, result.lon], { title: "Selected address point" }).addTo(map).bindPopup(popup);
    recenterAddress(result);
  },
  onRecenter: recenterAddress,
  onShowLayer(id) {
    const layer = prototypeLayers.get(id);
    if (layer && !map.hasLayer(layer)) layer.addTo(map);
    updateLayerStatus();
  },
  onRetry: loadPrototypeData,
});

map.on("resize", () => {
  if (map.getSize().x <= 640) layerControl.collapse();
  else layerControl.expand();
  if (selectedLocation) recenterAddress(selectedLocation);
});

const cameraIcon = L.divIcon({
  className: "flood-marker",
  html:
    '<div class="flood-marker-badge flood-story-badge"><svg viewBox="0 0 24 24"><path d="M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg></div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const videoIcon = L.divIcon({
  className: "flood-marker",
  html: '<div class="flood-marker-badge flood-video-badge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const storyPanel = document.getElementById("story-panel");
const storyPanelImage = document.getElementById("story-panel-image");
const storyPanelVideoWrapper = document.getElementById("story-panel-video-wrapper");
const storyPanelVideo = document.getElementById("story-panel-video");
const storyPanelTitle = document.getElementById("story-panel-title");
const storyPanelDescription = document.getElementById("story-panel-description");
const storyPanelCredit = document.getElementById("story-panel-credit");
const storyPanelLinks = document.getElementById("story-panel-links");
const storyPanelMeta = document.getElementById("story-panel-meta");
const storyImageNotice = document.getElementById("story-image-notice");
let storyReturnFocus = null;

function safeExternalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}

storyPanelImage.addEventListener("error", () => {
  if (storyPanel.hidden || !storyPanelImage.getAttribute("src")) return;
  storyPanelImage.style.display = "none";
  storyImageNotice.hidden = false;
});
storyPanelImage.addEventListener("load", () => { storyImageNotice.hidden = true; });

function openStoryPanel(story) {
  storyReturnFocus = document.activeElement;
  if (!document.getElementById("address-panel").hidden) addressPanel?.close();
  const imageURL = safeExternalURL(story.image);
  storyPanelImage.style.display = imageURL ? "" : "none";
  storyImageNotice.hidden = true;
  storyPanelImage.removeAttribute("src");
  if (imageURL) {
    storyPanelImage.src = imageURL;
    storyPanelImage.alt = story.image_alt || story.title;
  }

  const videoURL = safeExternalURL(story.video?.url);
  storyPanelVideoWrapper.style.display = videoURL ? "" : "none";
  storyPanelVideo.src = videoURL
    ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(videoURL)}&show_text=false`
    : "";

  storyPanelTitle.textContent = story.title;
  storyPanelDescription.textContent = story.description || "";
  storyPanelMeta.textContent = `${story.event_date || story.year || "Historical record"} · ${story.location_note || "Approximate story location; not a measured flood boundary."}`;

  storyPanelCredit.style.display = story.credit ? "" : "none";
  storyPanelCredit.textContent = story.credit || "";

  storyPanelLinks.replaceChildren();
  (story.links || []).forEach(({ label, url }) => {
    const href = safeExternalURL(url);
    if (href) storyPanelLinks.appendChild(sourceLink(`${label} →`, href));
  });
  const provenance = document.getElementById("story-provenance-content");
  provenance.replaceChildren();
  document.getElementById("story-provenance").open = false;
  [story.coordinate_attribution, story.media_rights_note,
    story.checked_on ? `Sources checked: ${story.checked_on} (not the event date).` : null]
    .filter(Boolean).forEach((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      provenance.appendChild(paragraph);
    });
  [["Representative location source", story.coordinate_source_url],
    [story.coordinate_license || "Coordinate licence", story.coordinate_license_url]]
    .forEach(([label, url]) => {
      const href = safeExternalURL(url);
      if (href) {
        const paragraph = document.createElement("p");
        paragraph.appendChild(sourceLink(label, href));
        provenance.appendChild(paragraph);
      }
    });

  storyPanel.hidden = false;
  storyPanel.classList.add("visible");
  document.getElementById("map-layout").classList.add("story-open");
  if (map.getSize().x <= 640) layerControl.collapse();
  storyPanel.scrollTop = 0;
  storyPanelTitle.focus({ preventScroll: true });
}

function closeStoryPanel(restoreFocus = false) {
  storyPanel.classList.remove("visible");
  storyPanel.hidden = true;
  document.getElementById("map-layout").classList.remove("story-open");
  storyPanelVideo.src = "";
  if (restoreFocus) storyReturnFocus?.focus?.({ preventScroll: true });
}

document.getElementById("story-panel-close").addEventListener("click", () => closeStoryPanel(true));
storyPanel.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeStoryPanel(true); }
});

let storiesLoaded = false;
let infrastructureLoaded = false;
const loadingContent = new Set();
map.on("popupopen", () => document.getElementById("map-layout").classList.add("popup-open"));
map.on("popupclose", () => document.getElementById("map-layout").classList.remove("popup-open"));

async function loadFloodStories() {
  if (storiesLoaded || loadingContent.has("stories")) return;
  loadingContent.add("stories");
  try {
    const stories = await FloodData.fetchJSON("data/flood_stories.json");
    if (!Array.isArray(stories) || stories.length === 0 || stories.some((story) => !story || typeof story.title !== "string" ||
        !story.title.trim() || typeof story.id !== "string" || !story.id.trim() ||
        !Array.isArray(story.links) || story.links.some((link) => !link || typeof link.label !== "string" || !safeExternalURL(link.url)) ||
        !Number.isFinite(story.lat) || !Number.isFinite(story.lng) ||
        story.lat < -38 || story.lat > -37.6 || story.lng < 144.7 || story.lng > 145.3) ||
        new Set(stories.map((story) => story.id)).size !== stories.length) {
      throw new Error("Invalid historical story locations");
    }
    const floodStoriesLayer = L.markerClusterGroup();
    stories.forEach((story) => {
      floodStoriesLayer.addLayer(
        L.marker([story.lat, story.lng], { icon: story.video ? videoIcon : cameraIcon, title: story.title, alt: story.title }).on("click", () =>
          openStoryPanel(story)
        )
      );
    });
    layerControl.addOverlay(floodStoriesLayer, "Historic flood stories");
    storiesLoaded = true;
    clearLayerFailure("Historic flood stories");
  } catch (err) {
    console.error("Failed to load flood stories", err);
    reportLayerFailure("Historic flood stories");
  } finally { loadingContent.delete("stories"); }
}

const facilitySymbols = {
  storage: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v13c0 4 14 4 14 0V5M5 12c0 4 14 4 14 0"/>',
  treepits: '<path d="M12 21V10M12 14C2 14 3 5 4 3c8 0 9 5 8 11ZM12 17c0-8 4-11 9-10 1 6-3 10-9 10ZM4 21h16"/>',
  raingardens: '<path d="M12 2S5 10 5 14a7 7 0 0 0 14 0c0-4-7-12-7-12ZM9 15c0 2 1 3 3 3"/>',
  paving: '<path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"/>',
};

function facilityIcon(category) {
  return L.divIcon({
    className: "infrastructure-marker",
    html: `<div class="infrastructure-marker-badge infrastructure-${category.key}"><svg viewBox="0 0 24 24" aria-hidden="true">${facilitySymbols[category.key]}</svg></div>`,
    iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18],
  });
}

async function loadInfrastructure() {
  if (infrastructureLoaded || loadingContent.has("infrastructure")) return;
  loadingContent.add("infrastructure");
  try {
    const collection = Infrastructure.validateCollection(await FloodData.fetchJSON("data/infrastructure.geojson"));
    const group = L.markerClusterGroup({
      maxClusterRadius: 32,
      // Keep the small educational set stable while a popup pans into view.
      animate: false,
      animateAddingMarkers: false,
      removeOutsideVisibleBounds: false,
      iconCreateFunction(cluster) {
        return L.divIcon({ className: "infrastructure-cluster", html: `<span>${cluster.getChildCount()}</span>`, iconSize: [38, 38] });
      },
    });
    collection.features.forEach((feature) => {
      const category = Infrastructure.getCategory(feature.properties.type);
      const [lon, lat] = feature.geometry.coordinates;
      const popupContent = Infrastructure.createPopup(feature, document);
      popupContent.setAttribute("tabindex", "-1");
      const marker = L.marker([lat, lon], { icon: facilityIcon(category), title: feature.properties.name, alt: feature.properties.name })
        .bindPopup(popupContent, { maxWidth: Math.min(320, map.getSize().x - 70),
          maxHeight: Math.min(360, Math.max(120, map.getSize().y - 140)),
          autoPanPaddingTopLeft: [15, 80], autoPanPaddingBottomRight: [15, 15], className: "infrastructure-popup-shell" })
        .on("popupopen", () => popupContent.focus({ preventScroll: true }))
        .on("click", () => {
          if (!document.getElementById("address-panel").hidden) addressPanel?.close();
          closeStoryPanel();
        });
      popupContent.querySelector("details")?.addEventListener("toggle", () => {
        const container = popupContent.parentElement;
        const scrollTop = container?.scrollTop || 0;
        marker.getPopup()?.update();
        if (container) container.scrollTop = scrollTop;
      });
      group.addLayer(marker);
    });
    layerControl.addOverlay(group, "Flood infrastructure (WSUD)");
    infrastructureLoaded = true;
    clearLayerFailure("Flood infrastructure");
  } catch (err) {
    console.error("Failed to load flood infrastructure", err);
    reportLayerFailure("Flood infrastructure");
  } finally { loadingContent.delete("infrastructure"); }
}

document.getElementById("retry-map-content").addEventListener("click", () => {
  loadInfrastructure();
  loadFloodStories();
});
loadFloodStories();
loadInfrastructure();
