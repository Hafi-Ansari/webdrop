const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g; // eslint-disable-line no-control-regex
// Zero-width, bidi embedding/override/isolate marks: an RLO can make
// "photo\u202Egpj.exe" display as "photoexe.jpg".
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const RESERVED = /[\\/:*?"<>|]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_CODEPOINTS = 200;

/**
 * Turn an untrusted, peer-supplied file name into something safe to save and
 * display: no path separators, control or bidi characters, reserved device
 * names, or leading/trailing dots; bounded length that keeps the extension.
 */
export function sanitizeFileName(raw: string): string {
  let name = raw.normalize("NFC").replace(CONTROL, "").replace(INVISIBLE, "").replace(RESERVED, "_");
  name = name.replace(/^[\s.]+|[\s.]+$/g, "");
  if (WINDOWS_DEVICE.test(name)) name = "_" + name;
  if (!name) name = "file";
  const chars = Array.from(name);
  if (chars.length > MAX_CODEPOINTS) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? Array.from(name.slice(dot)) : [];
    const keep = ext.length > 0 && ext.length <= 16 ? ext : [];
    name = chars.slice(0, MAX_CODEPOINTS - keep.length).join("") + keep.join("");
  }
  return name;
}

/** Peer-supplied MIME type, used for display only (never for saving). */
export function sanitizeMime(raw: string): string {
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(raw) ? raw.toLowerCase() : "";
}
