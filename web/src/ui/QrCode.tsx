import { useMemo } from "react";
import { encode } from "uqr";

/** QR code rendered as a single SVG path (no innerHTML; Trusted Types safe). */
export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  const { d, n } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.size };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label="QR code with the pairing link" shapeRendering="crispEdges" className="rounded-lg bg-white">
      <path d={d} fill="#282a36" />
    </svg>
  );
}
