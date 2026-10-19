# Prototype content provenance

Prepared 19 October 2026 from sources checked on 18 October 2026. These content files support a classroom prototype, not emergency advice, a live asset register or property-level flood-risk assessment.

## Infrastructure overlay

`infrastructure.geojson` contains eight selected points: three official bioretention asset-record points and five representative project locations. Each feature retains source links, coordinate provenance, licensing information, dates, location limitations and an unverified-current-operation status.

| Included content | Position basis | Evidence |
| --- | --- | --- |
| Bioretention beds 1568553, 1568554 and 1568555 | Published asset-record coordinates, transformed from EPSG:7855 to EPSG:4326; not surveyed inlets or bed boundaries | [City of Melbourne garden-bed inventory](https://data.melbourne.vic.gov.au/explore/dataset/renewals-for-nature-city-of-melbourne-garden-bed-inventory-2024/) |
| Lincoln Square storage system | Official park landmark point, not an underground-tank coordinate | [City project overview](https://participate.melbourne.vic.gov.au/elizabethstreet/plan-overview) |
| Queen Victoria Market rainwater system | Queen Street section representative point, not a surveyed tank location | [Clearwater case study](https://www.clearwatervic.com.au/resources/queen-victoria-market-rainwater-harvesting-case-study) |
| Little Bourke Street tree pits, Victoria/Elizabeth tree pits and Collins Street paving | Derived street-section/intersection representatives; no individual asset positions asserted | [2015 City catchment plan](https://mvga-prod-files.s3.ap-southeast-4.amazonaws.com/public/about-council/committees-meetings/meeting-archive/MeetingAgendaItemAttachments/679/12219/MAR15%2520FMC2%2520AGENDA%2520ITEM%25206.1.pdf) |

Coordinate data is credited to the City of Melbourne under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Garden-bed survey attribution also credits Royal Botanic Gardens Victoria. Project descriptions are short original paraphrases, not a claim that source documents have the same reuse licence. Street-derived positions use the City's [Street names dataset](https://data.melbourne.vic.gov.au/explore/dataset/street-names/); Lincoln Square uses the [landmark dataset](https://data.melbourne.vic.gov.au/explore/dataset/landmarks-and-places-of-interest-including-schools-theatres-health-services-spor/).

Do not infer live performance, available storage, condition, protection for nearby properties or an exhaustive list of facilities. The market tank description concerns a historical system; its current configuration is not confirmed. Optional litter traps and unverified University Square project details were deliberately not imported.

## Historic flood stories

`flood_stories.json` contains five source cards representing four distinct events. The two existing 1972 cards retain their original media, links and coordinates and share one `event_id`; they are not two floods. Their location notes now identify those positions as approximate original-prototype markers.

| New event | Evidence and media decision |
| --- | --- |
| 8 December 1862 | [SLV item H13599](https://handle.slv.vic.gov.au/10381/289412); remote image URL and attribution from the item's official IIIF manifest, which states the work is out of copyright. |
| 5 December 1882 | [SLV item A/S16/12/82/349](https://handle.slv.vic.gov.au/10381/257565); remote engraving URL and F. A. Sleap credit from the official IIIF manifest, which states the work is out of copyright. The event date is not the newspaper publication date. |
| 6 March 2010 | [City catchment plan](https://mvga-prod-files.s3.ap-southeast-4.amazonaws.com/public/2024-05/elizabeth-street-catchment-plan.pdf) and [BOM annual statement](https://www.bom.gov.au/climate/current/annual/aus/2010/); text and source links only, because no photograph with confirmed item-specific reuse permission was selected. |

No new image is downloaded or bundled. Existing 1972 media is retained without asserting a newly verified reuse licence. Each new archival image links to its rights manifest. If a remote image fails, the textual account and source links should remain usable.

On 19 October 2026, the two new archive images were switched to 800-pixel URLs from SLV's official IIIF Image API, because the presentation-manifest resource endpoints did not reliably return decodable images. No local copies are stored.

All story points are approximate narrative locations, not camera positions or mapped flood boundaries. The 1862 and 1882 stories intentionally use the same official Elizabeth Street representative coordinate rather than invented event-specific positions. The 2010 story does not validate an illustrative 2010 polygon; no historical story may be used to calculate address-level risk.

`checked_on` means source review date, not a field inspection or live-data update. Missing publication dates remain `null` rather than being guessed.
