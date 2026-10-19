/* Sourced infrastructure/project markers, not a live asset or protection assessment. */
(function (root) {
  "use strict";

  const CATEGORIES = Object.freeze({
    storage: Object.freeze({ key: "storage", label: "Stormwater / rainwater storage", iconText: "S" }),
    treepits: Object.freeze({ key: "treepits", label: "Water-sensitive tree pits", iconText: "T" }),
    raingardens: Object.freeze({ key: "raingardens", label: "Raingardens / bioretention", iconText: "R" }),
    paving: Object.freeze({ key: "paving", label: "Permeable paving", iconText: "P" }),
  });
  const TYPES = Object.freeze({
    bioretention_bed: Object.freeze({ category: "raingardens", label: "Bioretention bed" }),
    stormwater_harvesting_and_detention: Object.freeze({ category: "storage", label: "Stormwater harvesting and detention" }),
    roofwater_harvesting: Object.freeze({ category: "storage", label: "Rainwater harvesting" }),
    raingarden_tree_pits: Object.freeze({ category: "treepits", label: "Raingarden tree pits" }),
    infiltration_tree_pits: Object.freeze({ category: "treepits", label: "Infiltration tree pits" }),
    permeable_pavement: Object.freeze({ category: "paving", label: "Permeable pavement" }),
  });
  const PRECISIONS = new Set([
    "official_asset_record_point", "site_representative",
    "street_section_representative", "intersection_representative",
  ]);
  const TEXT_FIELDS = [
    "name", "popup_en", "location_note", "current_operation", "attribution",
  ];
  const OPTIONAL_TEXT_FIELDS = [
    "asset_id", "source_date", "assessment_date", "checked_on", "dataset_processed_utc",
    "capacity_context", "limitation", "coordinate_license", "license", "scope_note",
  ];

  function nonemptyText(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function safeURL(value) {
    if (!nonemptyText(value) || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !!parsed.hostname && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  }

  function getCategory(type) {
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw new Error("Unknown infrastructure type");
    return CATEGORIES[TYPES[type].category];
  }

  function validateFeature(feature) {
    const properties = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.type !== "Feature" || !properties || typeof properties !== "object" || Array.isArray(properties) ||
        feature.geometry?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2 ||
        !coordinates.every(Number.isFinite)) {
      throw new Error("Invalid infrastructure point feature");
    }
    // A city-scale sanity check catches projected coordinates and swapped lon/lat.
    // It is not a catchment-membership or a surveyed-location assessment.
    const [lon, lat] = coordinates;
    if (lon < 144.7 || lon > 145.2 || lat < -38 || lat > -37.6) {
      throw new Error("Infrastructure coordinates must be Melbourne longitude, latitude");
    }
    if (!nonemptyText(properties.id) || !/^[a-z0-9_-]+$/i.test(properties.id) ||
        TEXT_FIELDS.some((key) => !nonemptyText(properties[key])) ||
        !PRECISIONS.has(properties.location_precision)) {
      throw new Error("Missing infrastructure identity, description or provenance");
    }
    getCategory(properties.type);
    if (OPTIONAL_TEXT_FIELDS.some((key) => properties[key] != null && !nonemptyText(properties[key]))) {
      throw new Error("Invalid infrastructure provenance text");
    }
    if (!Array.isArray(properties.source_urls) || !properties.source_urls.length ||
        properties.source_urls.some((url) => !safeURL(url))) {
      throw new Error("Infrastructure sources must use valid HTTPS URLs");
    }
    for (const field of ["coordinate_source_url", "license_url"]) {
      if (properties[field] != null && !safeURL(properties[field])) throw new Error("Invalid infrastructure provenance URL");
    }
    if (!nonemptyText(properties.license) && !nonemptyText(properties.coordinate_license)) {
      throw new Error("Missing infrastructure data licence");
    }
    if (properties.location_precision !== "official_asset_record_point" && !safeURL(properties.coordinate_source_url)) {
      throw new Error("Approximate project markers need a coordinate source");
    }
    if (properties.documented_capacity_litres != null &&
        (!Number.isFinite(properties.documented_capacity_litres) || properties.documented_capacity_litres <= 0 ||
          !nonemptyText(properties.capacity_context))) {
      throw new Error("Documented storage capacity needs a positive value and context");
    }
    if (properties.documented_completion_year != null &&
        (!Number.isInteger(properties.documented_completion_year) || properties.documented_completion_year < 1800 || properties.documented_completion_year > 2100)) {
      throw new Error("Invalid documented completion year");
    }
    return feature;
  }

  function validateCollection(data) {
    if (!data || data.error || data.exceededTransferLimit === true ||
        data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
      throw new Error("Missing or incomplete infrastructure collection");
    }
    const ids = new Set();
    // Reject the entire file before creating any markers: a partial map can mislead.
    for (const feature of data.features) {
      validateFeature(feature);
      if (ids.has(feature.properties.id)) throw new Error("Duplicate infrastructure identity");
      ids.add(feature.properties.id);
    }
    return data;
  }

  function createPopup(feature, doc = root.document) {
    validateFeature(feature);
    if (!doc || typeof doc.createElement !== "function") throw new Error("A document is required for infrastructure popups");
    const p = feature.properties;
    function element(tag, text, className) {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function paragraph(parent, text, className) {
      parent.appendChild(element("p", text, className));
    }
    function link(parent, label, href) {
      // Validation is deliberately repeated at the point at which a link is built.
      if (!safeURL(href)) throw new Error("Unsafe infrastructure source link");
      const node = element("a", label);
      node.href = href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      parent.appendChild(node);
    }
    const popup = element("article", undefined, "infrastructure-popup");
    popup.appendChild(element("h3", p.name, "infrastructure-title"));
    paragraph(popup, TYPES[p.type].label, "infrastructure-type");
    const official = p.location_precision === "official_asset_record_point";
    paragraph(popup, official ? "Official asset-record location" : "Approximate project location",
      `infrastructure-precision ${official ? "infrastructure-precision-official" : "infrastructure-precision-approximate"}`);
    paragraph(popup, p.popup_en, "infrastructure-description");
    paragraph(popup, p.location_note, "infrastructure-location-note");
    paragraph(popup, `Current operation: ${p.current_operation}.`, "infrastructure-operation");
    paragraph(popup, "A marker does not establish current performance or flood protection for nearby properties.", "infrastructure-limitation");

    const details = element("details", undefined, "infrastructure-details");
    details.appendChild(element("summary", "Sources and project details"));
    if (p.documented_capacity_litres != null) {
      paragraph(details, `Documented storage capacity: ${p.documented_capacity_litres.toLocaleString("en-AU")} L. ${p.capacity_context}`, "infrastructure-capacity");
    }
    if (p.asset_id) paragraph(details, `City asset ID: ${p.asset_id}.`);
    if (p.assessment_date) paragraph(details, `Asset assessment date: ${p.assessment_date}.`);
    if (p.source_date) paragraph(details, `Source date: ${p.source_date}.`);
    if (p.documented_completion_year != null) paragraph(details, `Documented completion year: ${p.documented_completion_year} (historical source; not a current-condition check).`);
    if (p.checked_on) paragraph(details, `Sources checked: ${p.checked_on} (not a site inspection).`);
    if (p.limitation) paragraph(details, p.limitation);

    const sourceList = element("ul", undefined, "infrastructure-sources");
    p.source_urls.forEach((href, index) => {
      const item = element("li");
      link(item, `Source ${index + 1}`, href);
      sourceList.appendChild(item);
    });
    if (p.coordinate_source_url) {
      const item = element("li");
      link(item, "Coordinate source", p.coordinate_source_url);
      sourceList.appendChild(item);
    }
    details.appendChild(sourceList);
    paragraph(details, `Attribution: ${p.attribution}`, "infrastructure-attribution");
    if (p.license) paragraph(details, `Asset data licence: ${p.license}.`, "infrastructure-license");
    if (p.coordinate_license) paragraph(details, `Coordinate data licence: ${p.coordinate_license}. Project descriptions are linked separately.`, "infrastructure-license");
    if (p.license_url) {
      const licence = element("p");
      link(licence, "Data licence terms", p.license_url);
      details.appendChild(licence);
    }
    popup.appendChild(details);
    return popup;
  }

  const api = Object.freeze({ validateCollection, getCategory, createPopup });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Infrastructure = api;
})(typeof window === "undefined" ? globalThis : window);
