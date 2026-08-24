#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema, diagnoseJsonPath, findPdpPresentation, extractAmenities, extractHighlights, extractDescription, extractLocation, extractHouseRules, keyAmenityGroups } from "./util.js";
import robotsParser from "robots-parser";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch (error) {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description: "Search for Airbnb listings with various filters and pagination. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
      },
      propertyType: {
        type: "string",
        enum: ["entire_home", "private_room", "shared_room", "hotel_room"],
        description: "Filter by property type: 'entire_home' (entire homes/apartments), 'private_room' (private rooms in shared homes), 'shared_room' (shared/dorm-style rooms), 'hotel_room' (hotel rooms)"
      },
      currency: {
        type: "string",
        description: "ISO currency code for prices (e.g. USD, EUR, GBP). Defaults to whatever Airbnb picks for your IP's country, which is not necessarily your own \u2014 set this explicitly when on a VPN."
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    anyOf: [{ required: ["location"] }, { required: ["placeId"] }]
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description: "Get detailed information about a specific Airbnb listing. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      currency: {
        type: "string",
        description: "ISO currency code for prices (e.g. USD, EUR, GBP). Defaults to whatever Airbnb picks for your IP's country, which is not necessarily your own \u2014 set this explicitly when on a VPN."
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["id"]
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
] as const;

// Utility functions
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

// Geocode location using Photon (fast, no rate limits) with Nominatim fallback.
// This bypasses Airbnb's broken server-side geocoding for non-US locations.
// We fetch several results because the top hit is sometimes a landmark rather than
// the place itself, and because the best match may lack a bounding box.

// Types too granular to be what someone searching for a place to stay meant. A query
// for "Pensacola, FL" matches the naval air station and the federal prison camp; those
// are the results worth skipping past.
const PHOTON_REJECTED_TYPES = new Set(["house", "street", "other"]);

function pickBestPhotonFeature(features: any[]): any | null {
  // Take Photon's own top-ranked result, skipping only the granular types above.
  //
  // An earlier version ranked by an administrative-breadth table instead, on the
  // theory that broader is safer. It is not: a city and its province routinely share
  // a name, the province is always the broader type, so the table picked the province
  // every time. "Barcelona" resolved to a 190km box spanning Catalonia and returned
  // Costa Brava listings. Photon already ranks by relevance and put the city first in
  // every case checked (Barcelona, Paris, Stockholm, New York, Austin, Pensacola);
  // overriding that ranking was the whole bug.
  //
  // Don't filter by extent here — the best match (e.g. Stockholm, Sweden) may
  // lack an extent, and we'll fall back to Nominatim for the bbox.
  if (!features || features.length === 0) return null;

  const acceptable = features.find(
    (f: any) => !PHOTON_REJECTED_TYPES.has(f?.properties?.type)
  );
  // If everything matched a rejected type, the top hit is still better than nothing.
  return acceptable ?? features[0];
}

async function geocodeLocation(location: string): Promise<{
  ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string;
  displayName: string;
} | null> {
  let extent: number[] | null = null;
  let displayName = location;

  // Try Photon first — fast, no strict rate limits, OSM data.
  try {
    log('info', 'Geocoding location via Photon', { location });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json() as any;
      const feature = pickBestPhotonFeature(data?.features ?? []);
      if (feature) {
        if (feature.properties?.extent?.length === 4) {
          extent = feature.properties.extent; // [west_lng, north_lat, east_lng, south_lat]
        }
        displayName = feature.properties?.name || location;
        log('info', 'Photon selected feature', {
          location,
          type: feature.properties?.type,
          name: feature.properties?.name,
          country: feature.properties?.country,
          hasExtent: !!extent,
        });
      }
    }
  } catch (error) {
    log('warn', 'Photon geocoding failed', {
      location,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to Nominatim if Photon didn't return a bbox.
  // Nominatim ranks by importance so it handles ambiguous names well.
  // Nominatim usage policy requires an identifying User-Agent (not a browser UA).
  // See https://operations.osmfoundation.org/policies/nominatim/
  if (!extent) {
    try {
      log('info', 'Falling back to Nominatim for geocoding', { location });
      const nomController = new AbortController();
      const nomTimeout = setTimeout(() => nomController.abort(), 5000);
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
      let nomResponse;
      try {
        nomResponse = await fetch(nomUrl, {
          headers: {
            "User-Agent": `mcp-server-airbnb/${VERSION} (+https://github.com/openbnb-org/mcp-server-airbnb)`,
            "Accept": "application/json",
          },
          signal: nomController.signal,
        });
      } finally {
        clearTimeout(nomTimeout);
      }
      if (nomResponse.ok) {
        const nomResults = await nomResponse.json() as any[];
        if (nomResults?.[0]?.boundingbox?.length === 4) {
          const bb = nomResults[0].boundingbox; // [south_lat, north_lat, west_lng, east_lng]
          extent = [parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3]), parseFloat(bb[0])];
          displayName = nomResults[0].display_name?.split(",")?.[0] || location;
          log('info', 'Nominatim fallback succeeded', { location, extent });
        }
      }
    } catch (nomError) {
      log('warn', 'Nominatim fallback also failed', { location });
    }
  }

  if (!extent || extent.length !== 4) {
    log('warn', 'No bounding box from either geocoder', { location });
    return null;
  }

  // Expand bounding box by 25% in each direction (minimum 0.1°, ~11km)
  // to capture suburbs, beaches, and surrounding areas. OSM returns tight
  // administrative boundaries (e.g., Paris = just the arrondissements,
  // Pensacola = city limits without the beach on the barrier island).
  const swLat = extent[3];
  const neLat = extent[1];
  const swLng = extent[0];
  const neLng = extent[2];
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const coords = {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
    displayName,
  };

  log('info', 'Geocoded successfully (with 25% padding)', { location, coords });
  return coords;
}

const PROPERTY_TYPE_IDS: Record<string, string> = {
  entire_home:  "1",
  private_room: "2",
  shared_room:  "3",
  hotel_room:   "4",
};

// Configuration from environment variables (set by DXT host)
const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");
// When true, skip the Photon/Nominatim geocoding step and let Airbnb's own
// server-side geocoder handle the location string. Defaults to false so the
// fix for non-US locations stays on by default; users who want zero third-party
// outbound calls can opt out by setting DISABLE_GEOCODING=true.
const DISABLE_GEOCODING = process.env.DISABLE_GEOCODING === "true";
// Airbnb prices in the currency of the country domain it handed us off to, which
// follows the request's IP — so a VPN silently changes every price in the results.
// Set a default here to pin it regardless of where the connection appears to come from.
const DEFAULT_CURRENCY = process.env.AIRBNB_CURRENCY || "";

// Airbnb's robots.txt carries `Disallow: /s/*/*` under `User-agent: *`, which matches
// every URL airbnb_search builds — so with the default posture this tool cannot succeed
// at all. That is a deliberate choice by Airbnb, not a bug here, but the previous
// message ("you may or may not want to...") left callers guessing, so say plainly what
// is blocked and what the one option is.
const robotsErrorMessage = "Airbnb's robots.txt disallows this path for this User-agent. Airbnb blocks all /s/ search URLs (Disallow: /s/*/*), so airbnb_search cannot run under the default robots.txt-respecting posture. To proceed anyway, start the server with '--ignore-robots-txt', set IGNORE_ROBOTS_TXT=true, or pass ignoreRobotsText: true on the request \u2014 doing so is a decision to override the site's stated crawling preference."
let robotsTxtContent = "";

// Enhanced robots.txt fetch with timeout and error handling
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log('info', 'Skipping robots.txt fetch (ignored by configuration)');
    return;
  }

  try {
    log('info', 'Fetching robots.txt from Airbnb');
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    robotsTxtContent = await response.text();
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    log('warn', 'Error fetching robots.txt, assuming all paths allowed', {
      error: error instanceof Error ? error.message : String(error)
    });
    robotsTxtContent = ""; // Empty robots.txt means everything is allowed
  }
}

function isPathAllowed(path: string): boolean {  
  if (!robotsTxtContent) {
    return true; // If we couldn't fetch robots.txt, assume allowed
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt', { path, userAgent: USER_AGENT });
    }
    
    return allowed;
  } catch (error) {
    log('warn', 'Error parsing robots.txt, allowing path', {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return true; // If parsing fails, be permissive
  }
}

async function fetchWithUserAgent(url: string, timeout: number = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }

    throw error;
  }
}

// Airbnb geo-redirects www.airbnb.com to a country domain (www.airbnb.ca, .co.uk, …)
// using an HTML form that JavaScript submits on load — not an HTTP 3xx. fetch follows
// redirects but cannot run scripts, so from outside the US every request returned a
// ~900-byte stub with none of the page data in it. That surfaced as "page structure
// may have changed" on both tools, for every non-US user, permanently.
//
// The stub names its own target in the form action, so read it, remember the origin,
// and retry there. Cached for the process: the answer is per-IP, not per-URL.
let resolvedOrigin: string | null = null;

const DOMAIN_HANDOFF_PATTERN = /<form[^>]*action="(https:\/\/[^"/]+)\/v2\/domain_switch\/handoff"/i;

function withResolvedOrigin(url: string): string {
  if (!resolvedOrigin) return url;
  const target = new URL(url);
  const origin = new URL(resolvedOrigin);
  target.protocol = origin.protocol;
  target.host = origin.host;
  return target.toString();
}

// The stub is under a kilobyte and a real listing page is ~850KB, so scanning only the
// head of the document keeps this free on the responses that actually matter.
function detectDomainHandoff(html: string): string | null {
  const match = html.slice(0, 4096).match(DOMAIN_HANDOFF_PATTERN);
  return match ? match[1] : null;
}

async function fetchPage(url: string, timeout: number = 30000): Promise<{ html: string; url: string }> {
  let target = withResolvedOrigin(url);
  let html = await (await fetchWithUserAgent(target, timeout)).text();

  const handoff = detectDomainHandoff(html);
  if (!handoff) return { html, url: target };

  const previousOrigin = resolvedOrigin;
  resolvedOrigin = handoff;
  const retryTarget = withResolvedOrigin(url);

  // Only retry when the origin actually moved. Retrying the same URL because it
  // handed off to itself is a loop, not a fix.
  if (retryTarget === target) {
    resolvedOrigin = previousOrigin;
    return { html, url: target };
  }

  log('info', 'Following Airbnb domain handoff', { from: target, to: retryTarget });
  target = retryTarget;
  html = await (await fetchWithUserAgent(target, timeout)).text();

  if (detectDomainHandoff(html)) {
    // Nowhere better to go. Return what we have and let the parse path report it.
    log('warn', 'Domain handoff repeated after retry', { url: target });
  }

  return { html, url: target };
}

/**
 * Airbnb's deferred state is an array of query results, and which slot holds the
 * search is not fixed — `niobeClientData[0][1]` was an assumption, not a contract.
 * Scan for the entry that actually carries the results instead.
 */
function findSearchResults(clientData: any): any | null {
  const entries = clientData?.niobeClientData;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const results = entry?.[1]?.data?.presentation?.staysSearch?.results;
    if (results && Array.isArray(results.searchResults)) return results;
  }
  return null;
}

/**
 * Listing ids arrive base64-encoded as "DemandStayListing:1234". Returns null rather
 * than throwing for anything that is not that, so a single malformed card is skipped
 * instead of failing the search.
 */
function decodeListingId(encoded: any): string | null {
  if (typeof encoded !== "string" || !encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const id = decoded.includes(":") ? decoded.split(":")[1] : decoded;
    // A wrong guess at the encoding decodes to mojibake, which would otherwise sail
    // through as a plausible-looking id and produce a 404 link.
    return /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// API handlers
async function handleAirbnbSearch(params: any) {
  const {
    location,
    placeId,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    cursor,
    propertyType,
    currency = DEFAULT_CURRENCY,
    ignoreRobotsText = false,
  } = params;

  // Build search URL
  // Airbnb path segments use "--" as the separator (e.g. "Paris--France"),
  // not URL-encoded punctuation.  encodeURIComponent turns commas into %2C
  // which confuses Airbnb's geocoder (e.g. Paris → Barneville-Carteret).
  //
  // `location` is only required when there is no placeId. The schema has always said
  // placeId overrides location, but the slug was built unconditionally, so passing a
  // placeId alone crashed on `location.replace` — the low-level MCP Server does not
  // validate arguments against inputSchema, so nothing caught it earlier.
  if (!location && !placeId) {
    throw new McpError(ErrorCode.InvalidParams, "Either 'location' or 'placeId' is required");
  }
  const searchPath = location
    ? `/s/${encodeURIComponent(
        location
          .replace(/,\s*/g, "--")   // "Paris, France" → "Paris--France"
          .replace(/\s+/g, "-")     // remaining spaces → single dash
      )}/homes`
    : "/s/homes";                   // Airbnb's own form when the place comes from place_id
  const searchUrl = new URL(`${BASE_URL}${searchPath}`);
  // The URL actually fetched, which differs from searchUrl once a domain handoff is
  // followed. Reporting the pre-handoff URL would hand the caller a link that returns
  // a redirect stub rather than the results they were just shown.
  let fetchedUrl = searchUrl.toString();
  
  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);
  
  // Geocode and add bounding box to fix broken server-side geocoding.
  // Skipped when placeId is supplied (Airbnb's place lookup is reliable for those)
  // or when DISABLE_GEOCODING=true (user opt-out from third-party calls).
  if (!placeId && location && !DISABLE_GEOCODING) {
    const coords = await geocodeLocation(location);
    if (coords) {
      searchUrl.searchParams.append("ne_lat", coords.ne_lat);
      searchUrl.searchParams.append("ne_lng", coords.ne_lng);
      searchUrl.searchParams.append("sw_lat", coords.sw_lat);
      searchUrl.searchParams.append("sw_lng", coords.sw_lng);
    }
  }
  
  // Add query parameters
  if (checkin) searchUrl.searchParams.append("checkin", checkin);
  if (checkout) searchUrl.searchParams.append("checkout", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", adults_int.toString());
    searchUrl.searchParams.append("children", children_int.toString());
    searchUrl.searchParams.append("infants", infants_int.toString());
    searchUrl.searchParams.append("pets", pets_int.toString());
  }
  
  // Add price range
  if (minPrice != null) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice != null) searchUrl.searchParams.append("price_max", maxPrice.toString());
  
  // Add property type filter
  if (propertyType && PROPERTY_TYPE_IDS[propertyType]) {
    searchUrl.searchParams.append("l2_property_type_ids[]", PROPERTY_TYPE_IDS[propertyType]);
  }

  // Add cursor for pagination
  if (cursor) {
    searchUrl.searchParams.append("cursor", cursor);
  }

  if (currency) searchUrl.searchParams.append("currency", currency);

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt', { path, url: searchUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: searchUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing : {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true
      },
      mapSecondaryLine: {
        body: true
      },
      primaryLine: {
        body: true
      },
      secondaryLine: {
        body: true
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true
          }
        }
      }
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  try {
    log('info', 'Performing Airbnb search', { location, checkin, checkout, adults, children });
    
    const page = await fetchPage(searchUrl.toString());
    fetchedUrl = page.url;
    const $ = cheerio.load(page.html);

    let staysSearchResults: any = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const results = findSearchResults(clientData);
      if (!results) {
        throw new Error("Could not locate staysSearch results in the page data");
      }
      cleanObject(results);

      const rawResults: any[] = Array.isArray(results.searchResults) ? results.searchResults : [];
      let skipped = 0;

      staysSearchResults = {
        searchResults: rawResults
          .map((result: any) => {
            // One unexpected card must not cost the caller the other seventeen. Airbnb
            // mixes non-listing entries into searchResults, and an entry without an
            // encoded id used to throw here and fail the whole search as a parse error.
            const shaped = flattenArraysInObject(pickBySchema(result, allowSearchResultSchema));
            const id = decodeListingId(shaped?.demandStayListing?.id);
            if (!id) {
              skipped++;
              return null;
            }
            return { id, url: `${resolvedOrigin ?? BASE_URL}/rooms/${id}`, ...shaped };
          })
          .filter(Boolean),
        paginationInfo: results.paginationInfo
      }

      log('info', 'Search completed successfully', {
        resultCount: staysSearchResults.searchResults?.length || 0,
        skippedResults: skipped || undefined
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const searchPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'staysSearch', 'results'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, searchPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse search results', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        url: fetchedUrl
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            searchUrl: fetchedUrl
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          searchUrl: fetchedUrl,
          ...staysSearchResults
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Search request failed', {
      error: error instanceof Error ? error.message : String(error),
      url: fetchedUrl
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          searchUrl: fetchedUrl,
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    currency = DEFAULT_CURRENCY,
    ignoreRobotsText = false,
  } = params;

  // Build listing URL
  const listingUrl = new URL(`${BASE_URL}/rooms/${id}`);
  // See the note on fetchedUrl in handleAirbnbSearch.
  let fetchedListingUrl = listingUrl.toString();
  
  // Add query parameters
  if (checkin) listingUrl.searchParams.append("check_in", checkin);
  if (checkout) listingUrl.searchParams.append("check_out", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", adults_int.toString());
    listingUrl.searchParams.append("children", children_int.toString());
    listingUrl.searchParams.append("infants", infants_int.toString());
    listingUrl.searchParams.append("pets", pets_int.toString());
  }

  if (currency) listingUrl.searchParams.append("currency", currency);

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt', { path, url: listingUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: listingUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSectionSchema: Record<string, any> = {
    "LOCATION_DEFAULT": {
      lat: true,
      lng: true,
      subtitle: true,
      title: true
    },
    "POLICIES_DEFAULT": {
      title: true,
      houseRulesSections: {
        title: true,
        items : {
          title: true
        }
      }
    },
    "HIGHLIGHTS_DEFAULT": {
      highlights: {
        title: true
      }
    },
    "DESCRIPTION_DEFAULT": {
      htmlDescription: {
        htmlText: true
      }
    },
    "AMENITIES_DEFAULT": {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true
        }
      }
    },
    //"AVAILABLITY_CALENDAR_DEFAULT": true,
  };

  try {
    log('info', 'Fetching listing details', { id, checkin, checkout, adults, children });
    
    const page = await fetchPage(listingUrl.toString());
    fetchedListingUrl = page.url;
    const $ = cheerio.load(page.html);
    
    // Always an array. A consumer doing details.find(...) should never meet an object.
    let details: any[] = [];
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const sections = clientData.niobeClientData[0][1].data.presentation.stayProductDetailPage.sections.sections;
      sections.forEach((section: any) => cleanObject(section));
      
      let extracted: any[] = sections
        .filter((section: any) => allowSectionSchema.hasOwnProperty(section.sectionId))
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(keyAmenityGroups(pickBySchema(section.section, allowSectionSchema[section.sectionId])))
          }
        });

      // Fill in the sections Airbnb now renders client-side.
      //
      // Substitute only when the content key this section exists to carry is actually
      // absent. Counting keys would be fragile in the direction that loses data: if
      // Airbnb ever adds one placeholder key to a stub, a count-based test would decide
      // the section was populated and silently discard the recovered content.
      const pdp = findPdpPresentation(clientData);
      const recovered: string[] = [];
      if (pdp) {
        const fromPdp: Record<string, { value: any | null; contentKey: string }> = {
          AMENITIES_DEFAULT: { value: extractAmenities(pdp), contentKey: "seeAllAmenitiesGroups" },
          HIGHLIGHTS_DEFAULT: { value: extractHighlights(pdp), contentKey: "highlights" },
          DESCRIPTION_DEFAULT: { value: extractDescription(pdp), contentKey: "htmlDescription" },
          LOCATION_DEFAULT: { value: extractLocation(pdp), contentKey: "lat" },
          POLICIES_DEFAULT: { value: extractHouseRules(pdp), contentKey: "houseRulesSections" },
        };

        extracted = extracted.map((section: any) => {
          const replacement = fromPdp[section.id];
          if (replacement?.value && !section[replacement.contentKey]) {
            recovered.push(section.id);
            // Merge onto the section rather than replacing it. A stub can be partial —
            // carrying a title while missing the content — and rebuilding from `id`
            // alone would throw away whatever the section tree did manage to supply.
            return { ...section, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) };
          }
          return section;
        });

        // Also cover the case where the stub is dropped from the section list entirely.
        for (const [sectionId, replacement] of Object.entries(fromPdp)) {
          if (replacement.value && !extracted.some((s: any) => s.id === sectionId)) {
            recovered.push(sectionId);
            extracted.push({ id: sectionId, ...flattenArraysInObject(keyAmenityGroups(replacement.value)) });
          }
        }
      }

      details = extracted;

      log('info', 'Listing details fetched successfully', {
        id,
        sectionsFound: extracted.length,
        recoveredFromPdpPresentation: recovered.length ? recovered : undefined
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const detailsPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'stayProductDetailPage', 'sections', 'sections'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, detailsPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse listing details', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        id,
        url: fetchedListingUrl
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            listingUrl: fetchedListingUrl
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: fetchedListingUrl,
          details: details
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Listing details request failed', {
      error: error instanceof Error ? error.message : String(error),
      id,
      url: fetchedListingUrl
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          listingUrl: fetchedListingUrl,
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Enhanced logging for DXT
function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  disableGeocoding: DISABLE_GEOCODING,
  defaultCurrency: DEFAULT_CURRENCY || undefined,
  nodeVersion: process.version,
  platform: process.platform
});

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  
  try {
    // Validate request parameters
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    
    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }
    
    log('info', 'Tool call received', { 
      tool: request.params.name,
      arguments: request.params.arguments 
    });
    
    // Ensure robots.txt is loaded
    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "airbnb_search": {
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
    
    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', { 
      tool: request.params.name, 
      duration: `${duration}ms`,
      success: !result.isError 
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
});

async function runServer() {
  try {
    // Initialize robots.txt on startup
    await fetchRobotsTxt();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT
    });
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
    
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
