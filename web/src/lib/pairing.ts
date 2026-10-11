/** Crockford base32: accept lowercase, spaces/dashes and the usual look-alikes (O->0, I/L->1). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");
}
