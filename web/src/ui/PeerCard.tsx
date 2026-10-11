import { Laptop, Smartphone, Tablet } from "lucide-react";
import { useRef, useState } from "react";
import { describeDevice } from "../lib/device.ts";
import type { PeerView } from "../lib/controller.ts";

interface Props {
  peer: PeerView;
  /** 0..1 progress of an outgoing transfer to this peer, if any. */
  progress: number | undefined;
  onFiles: (files: File[]) => void;
}

const RING = 2 * Math.PI * 34;

export function PeerCard({ peer, progress, onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const Icon = peer.device.form === "mobile" ? Smartphone : peer.device.form === "tablet" ? Tablet : Laptop;
  const paired = peer.rooms.some((r) => r !== "net");

  return (
    <li>
      <button
        type="button"
        data-testid="peer"
        aria-label={`Send files to ${peer.name}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        }}
        className="group flex w-36 flex-col items-center gap-1.5 rounded-2xl p-3 text-center outline-none transition hover:bg-ink-raised focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          className={`relative mb-1 grid size-[4.5rem] place-items-center rounded-full bg-accent text-ink transition-transform group-hover:scale-110 ${over ? "scale-110 ring-4 ring-accent/40" : ""}`}
        >
          <Icon className="size-8" aria-hidden />
          {progress !== undefined && (
            <svg className="absolute -inset-1.5 size-[5.25rem] -rotate-90" viewBox="0 0 76 76" aria-hidden>
              <circle cx="38" cy="38" r="34" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="4" className="text-fg" />
              <circle
                cx="38"
                cy="38"
                r="34"
                fill="none"
                strokeWidth="4"
                strokeLinecap="round"
                className="stroke-fg transition-[stroke-dashoffset]"
                strokeDasharray={RING}
                strokeDashoffset={RING * (1 - progress)}
              />
            </svg>
          )}
        </span>
        <span className="w-full truncate text-sm font-medium" data-testid="peer-name">
          {peer.name}
        </span>
        <span className="text-xs text-mist">{describeDevice(peer.device)}</span>
        {paired && <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">Paired</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </li>
  );
}
