// ---------------------------------------------------------------------------
// Runtime egress origin gate (D9, chunk 2).
//
// The single trust boundary for every configured egress target — processing
// providers and the remote-save endpoint alike. A URL is allowed iff its origin
// is SAME-ORIGIN (the deployment's own server, deployment-controlled by
// definition — zero config) or listed in an allow-list fetched from a FIXED
// same-origin path. Missing / empty / unreachable allow-list ⇒ same-origin only.
//
// "Default-deny" means a CROSS-origin target never passes unless the deployment
// says so — not that the feature is off until a file is served. Invariant: the
// allow-list is read ONLY from the deployment-controlled same-origin source
// (`/processing-origins.json`), never from a URL param, a remote manifest, or a
// field inside an imported config — otherwise a config could allow-list itself.
//
// This is the sole v1 egress control (the deployment-layer CSP `connect-src`
// backstop is deep-deferred), with Girder ACLs behind it.
// ---------------------------------------------------------------------------

import { z } from 'zod';

// Fixed, same-origin by construction: the browser resolves an absolute-path
// request against `window.location.origin`, so a crafted config/URL param can
// never point the gate at a forgeable source.
export const PROCESSING_ORIGINS_PATH = '/processing-origins.json';

// Canonical shape `{ "origins": ["https://facade.example", ...] }`. A bare JSON
// array of origins is tolerated as an operator convenience. Anything else is
// treated as an empty list (fail closed to same-origin only).
const allowListObject = z.object({
  origins: z.array(z.string()).default([]),
});
const allowListArray = z.array(z.string());

// Resolve any egress URL (possibly relative) to its origin. A relative URL
// resolves against the current document, i.e. same-origin.
export const resolveOrigin = (url: string): string | null => {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return null;
  }
};

// Normalize an allow-list entry to an origin. An entry may be a full origin
// (`https://host`) or a bare `host`/`host:port` an operator typed without a
// scheme; assume https for the latter so a common mistake does not silently
// drop the entry.
const normalizeAllowListEntry = (entry: string): string | null => {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)
    ? entry
    : `https://${entry}`;
  try {
    const { origin } = new URL(candidate);
    if (origin && origin !== 'null') return origin;
  } catch {
    // fall through to the warning below
  }
  console.warn(`Ignoring invalid egress origin: ${entry}`);
  return null;
};

const parseAllowList = (raw: unknown): string[] => {
  const parsed = Array.isArray(raw)
    ? allowListArray.safeParse(raw)
    : allowListObject.safeParse(raw);
  if (!parsed.success) {
    console.warn(`Ignoring malformed ${PROCESSING_ORIGINS_PATH}`);
    return [];
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.origins;
};

const fetchAllowedOrigins = async (): Promise<Set<string>> => {
  try {
    const response = await fetch(PROCESSING_ORIGINS_PATH, {
      headers: { Accept: 'application/json' },
    });
    // A 404 is the normal "no allow-list served" case (e.g. the demo): stay
    // silent and fall back to same-origin only.
    if (!response.ok) return new Set();
    const origins = parseAllowList(await response.json())
      .map(normalizeAllowListEntry)
      .filter((origin): origin is string => origin !== null);
    return new Set(origins);
  } catch {
    // Not served / network error ⇒ same-origin only.
    return new Set();
  }
};

// The allow-list is deployment-static, so fetch it at most once per app
// lifetime and memoize the in-flight promise (applyProcessingConfig runs once
// per imported config manifest; several may arrive in one launch).
let allowedOriginsPromise: Promise<Set<string>> | null = null;

const getAllowedOrigins = (): Promise<Set<string>> => {
  if (!allowedOriginsPromise) allowedOriginsPromise = fetchAllowedOrigins();
  return allowedOriginsPromise;
};

/**
 * The one gate for all configured egress. Resolves to `true` iff `url`'s origin
 * is same-origin or present in the deployment's allow-list.
 */
export const isOriginAllowed = async (url: string): Promise<boolean> => {
  const origin = resolveOrigin(url);
  if (!origin) return false;
  // Same-origin is implicitly trusted (deployment-controlled by definition).
  if (origin === window.location.origin) return true;
  const allowed = await getAllowedOrigins();
  return allowed.has(origin);
};

/**
 * Test seam: drop the memoized allow-list so a spec can re-stub the fetch. Not
 * used in production (the allow-list never changes within an app lifetime).
 */
export const resetAllowedOriginsCache = () => {
  allowedOriginsPromise = null;
};
