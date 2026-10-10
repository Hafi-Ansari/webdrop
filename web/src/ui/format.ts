const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Decimal units, like Finder and most download managers. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${UNITS[i]}`;
}

export const formatRate = (bytesPerSecond: number): string => `${formatBytes(Math.round(bytesPerSecond))}/s`;

export function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return "";
  const s = Math.ceil(remainingBytes / bytesPerSecond);
  if (s < 60) return `${s} s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}

export function summarizeFiles(files: { name: string }[]): string {
  if (files.length === 1) return files[0]?.name ?? "1 file";
  return `${files.length} files`;
}
