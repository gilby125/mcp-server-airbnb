export function cleanObject(obj: any) {
  Object.keys(obj).forEach(key => {
    if (obj[key] == null || key === "__typename") {
      delete obj[key];
    } else if (typeof obj[key] === "object") {
      cleanObject(obj[key]);
    }
  });
}

export function diagnoseJsonPath(data: any, path: string[]): string {
  let current = data;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return `Path broken at '${key}': parent is ${current === null ? 'null' : typeof current}`;
    }
    if (!(key in current)) {
      const available = Object.keys(current).slice(0, 10).join(', ');
      return `Key '${key}' not found. Available keys: [${available}]`;
    }
    current = current[key];
  }
  return 'Path valid';
}

export function pickBySchema(obj: any, schema: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  // If the object is an array, process each item
  if (Array.isArray(obj)) {
    return obj.map(item => pickBySchema(item, schema));
  }
  
  const result: Record<string, any> = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const rule = schema[key];
      // If the rule is true, copy the value as-is
      if (rule === true) {
        result[key] = obj[key];
      }
      // If the rule is an object, apply the schema recursively
      else if (typeof rule === 'object' && rule !== null) {
        result[key] = pickBySchema(obj[key], rule);
      }
    }
  }
  return result;
}

export function flattenArraysInObject(input: any, inArray: boolean = false): any {
  if (Array.isArray(input)) {
    // Process each item in the array with inArray=true so that any object
    // inside the array is flattened to a string.
    const flatItems = input.map(item => flattenArraysInObject(item, true));
    return flatItems.join(', ');
  } else if (typeof input === 'object' && input !== null) {
    if (inArray) {
      // When inside an array, ignore the keys and flatten the object's values.
      const values = Object.values(input).map(value => flattenArraysInObject(value, true));
      return values.join(': ');
    } else {
      // When not in an array, process each property recursively.
      const result: Record<string, any> = {};
      for (const key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          result[key] = flattenArraysInObject(input[key], false);
        }
      }
      return result;
    }
  } else {
    // For primitives, simply return the value.
    return input;
  }
}

/**
 * Airbnb wraps user-visible strings in several interchangeable envelopes, and which
 * one a given field uses has changed under us more than once — `highlights` shipped
 * as `{ title, subtitle }` and is now `{ headline: { localizedContent }, body: {...} }`.
 * Reading one shape and returning null on the others is how HIGHLIGHTS_DEFAULT went
 * silently empty, so unwrap every envelope we have seen rather than betting on one.
 */
export function localizedText(value: any): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value || typeof value !== "object") return undefined;
  const candidate =
    value.localizedContent ??
    value.localizedStringWithTranslationPreference ??
    value.localizedString ??
    value.text ??
    // Both wrap another envelope rather than a string: PdpUGCText nests under
    // `content`, UGCTextWrapper under `ugcContent`. Highlights use all three forms
    // across listings on the same day — LISTING_GUEST_FAVORITE arrives as
    // LocalizedContent, LISTING_CUSTOM_OFFLINE_GENERATED as UGCTextWrapper — so this
    // is a set to unwrap, not a schema version to pick.
    value.ugcContent ??
    value.content;
  if (candidate && typeof candidate === "object") return localizedText(candidate);
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

/**
 * Airbnb moved several PDP sections to client-side rendering. Their entries under
 * `presentation.stayProductDetailPage.sections.sections` still exist, still report
 * sectionContentStatus COMPLETE, but carry a `section` object containing nothing but
 * `__typename`. AMENITIES_DEFAULT and HIGHLIGHTS_DEFAULT are both in that state, so
 * the schema-driven extraction returns an empty shell rather than failing loudly.
 *
 * The content now lives on a sibling branch of the same payload:
 *   niobeClientData[i][1].data.node.pdpPresentation
 *
 * Returns null when the branch is absent, so callers fall back to whatever the
 * section tree gave them rather than losing data if Airbnb moves it again.
 */
export function findPdpPresentation(clientData: any): any | null {
  const entries = clientData?.niobeClientData;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const pdp = entry?.[1]?.data?.node?.pdpPresentation;
    if (pdp && typeof pdp === "object") return pdp;
  }
  return null;
}

/**
 * Amenity groups, preserving each item's `available` flag.
 *
 * The flag is the whole point: Airbnb renders unavailable amenities struck through,
 * and a listing that advertises air conditioning in its description while carrying
 * `available: false` on the amenity is the exact case a reader needs to catch.
 * Grouping by availability makes that impossible to skim past, where a flat list of
 * titles would quietly assert the opposite of the truth.
 */
export function extractAmenities(pdp: any): any | null {
  const groups = pdp?.amenities?.seeAllAmenitiesGroups;
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const label = (a: any, markUnavailable: boolean) => {
    const title = a?.title;
    if (!title) return null;
    // Airbnb has shipped this as both a plain string and a { text } object.
    const sub = typeof a?.subtitle === "string" ? a.subtitle : a?.subtitle?.text;
    const base = sub ? `${title} (${sub})` : title;
    return markUnavailable && a?.available === false ? `${base} — unavailable` : base;
  };

  const mapped = groups
    .map((group: any) => {
      const items = Array.isArray(group?.amenities) ? group.amenities : [];
      // Airbnb files struck-through amenities under a group of their own ("Not
      // included"), where the category name already carries the meaning and marking
      // each item would just repeat it. A group holding both is the case that needs
      // help: the name cannot speak for every item, so the unavailable ones say it
      // themselves rather than reading as amenities the listing offers.
      const mixed =
        items.some((a: any) => a?.available === false) &&
        items.some((a: any) => a?.available !== false);
      const amenities = items.map((a: any) => label(a, mixed)).filter(Boolean);
      return amenities.length ? { title: group?.title, amenities } : null;
    })
    .filter(Boolean);

  if (!mapped.length) return null;

  return {
    ...(pdp?.amenities?.title ? { title: pdp.amenities.title } : {}),
    seeAllAmenitiesGroups: mapped,
  };
}

/**
 * Turn `[{ title: "Bathroom", amenities: [...] }, ...]` into `{ Bathroom: [...], ... }`.
 *
 * The category is the useful part of an amenity list, and as an array element its title
 * survives only as a prefix inside one long joined string — a consumer that wants the
 * bathroom amenities has to parse them back out, and cannot tell a category boundary
 * from a comma inside a category. As an object key it is addressable directly, and
 * flattenArraysInObject leaves top-level keys alone, so each category flattens to its
 * own string. Airbnb's own "Not included" group lands here like any other category.
 *
 * Applied to both the section tree and the recovered pdpPresentation content so the two
 * paths cannot disagree about the shape. Untitled groups fall back to "Other" rather
 * than being dropped, and duplicate titles merge instead of overwriting.
 */
export function keyAmenityGroups(section: any): any {
  if (section === null || typeof section !== "object" || Array.isArray(section)) return section;

  const groups = section.seeAllAmenitiesGroups;
  if (!Array.isArray(groups)) return section;

  const keyed: Record<string, any[]> = {};
  for (const group of groups) {
    const items = Array.isArray(group?.amenities) ? group.amenities : [];
    if (!items.length) continue;
    const key = group?.title || "Other";
    keyed[key] = keyed[key] ? keyed[key].concat(items) : items;
  }

  return { ...section, seeAllAmenitiesGroups: keyed };
}

export function extractHighlights(pdp: any): any | null {
  const highlights = pdp?.highlights;
  if (!Array.isArray(highlights) || highlights.length === 0) return null;
  const mapped = highlights
    .map((h: any) => {
      // `headline`/`body` is the current shape; `title`/`subtitle` was the previous
      // one. Both are read because neither is guaranteed to be the one that survives.
      const title = localizedText(h?.headline) ?? localizedText(h?.title);
      // Interpolating first would turn a missing title into the literal string
      // "null: Free parking on premises", which .filter(Boolean) cannot catch.
      if (!title) return null;
      const sub = localizedText(h?.body) ?? localizedText(h?.subtitle);
      return sub ? `${title}: ${sub}` : title;
    })
    .filter(Boolean);

  return mapped.length ? { highlights: mapped } : null;
}

/**
 * The listing description, matching the DESCRIPTION_DEFAULT section's own shape so a
 * consumer cannot tell whether it came from the section tree or the recovery path.
 */
export function extractDescription(pdp: any): any | null {
  const descriptions = pdp?.descriptions;
  if (!descriptions || typeof descriptions !== "object") return null;
  const htmlText =
    localizedText(descriptions.longDescriptionHtml) ??
    localizedText(descriptions.shortDescriptionHtml);
  return htmlText ? { htmlDescription: { htmlText } } : null;
}

/**
 * Coordinates plus whatever the page says about the area.
 *
 * The two sources disagree by listing rather than by schema version: one listing
 * carries `location.subtitle` and empty detail arrays, the next carries populated
 * details and a null subtitle. Reading only one yields a section that is present and
 * blank on half of all listings, so both are consulted and the coordinates — the part
 * that is always there — are emitted independently of either.
 */
export function extractLocation(pdp: any): any | null {
  const location = pdp?.location;
  if (!location || typeof location !== "object") return null;

  const details = Array.isArray(location.previewLocationDetails) && location.previewLocationDetails.length
    ? location.previewLocationDetails
    : Array.isArray(location.seeAllLocationDetails)
      ? location.seeAllLocationDetails
      : [];

  const title =
    localizedText(location.subtitle) ??
    localizedText(details[0]?.title) ??
    localizedText(pdp?.localizedLocation);

  const subtitle = details
    .map((d: any) => localizedText(d?.content))
    .filter(Boolean)
    .join(" ");

  const lat = typeof location.latitude === "number" ? location.latitude : undefined;
  const lng = typeof location.longitude === "number" ? location.longitude : undefined;

  const result: Record<string, any> = {};
  if (lat !== undefined) result.lat = lat;
  if (lng !== undefined) result.lng = lng;
  if (title) result.title = title;
  if (subtitle) result.subtitle = subtitle;

  return Object.keys(result).length ? result : null;
}

/**
 * House rules, keyed by group title for the same reason amenity groups are: as array
 * elements the group names survive only as prefixes inside one joined string.
 *
 * An item's `description` carries the part that changes the meaning — "Quiet hours"
 * alone is not a rule until you know it means 6:00 p.m.–10:00 a.m. — so it is folded
 * into the item text rather than dropped.
 */
export function extractHouseRules(pdp: any): any | null {
  const rules = pdp?.rules;
  const groups = rules?.groupItems;
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const keyed: Record<string, string[]> = {};
  for (const group of groups) {
    const items = Array.isArray(group?.items) ? group.items : [];
    const mapped = items
      .map((item: any) => {
        const title = localizedText(item?.title);
        if (!title) return null;
        const description = localizedText(item?.description);
        return description ? `${title} (${description})` : title;
      })
      .filter(Boolean) as string[];
    if (!mapped.length) continue;
    const key = localizedText(group?.title) || "Other";
    keyed[key] = keyed[key] ? keyed[key].concat(mapped) : mapped;
  }

  if (!Object.keys(keyed).length) return null;

  return {
    ...(localizedText(rules?.title) ? { title: localizedText(rules.title) } : {}),
    houseRulesSections: keyed,
  };
}
