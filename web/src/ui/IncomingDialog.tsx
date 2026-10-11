import { File as FileIcon, ShieldCheck } from "lucide-react";
import type { TransferView } from "../lib/controller.ts";
import { Dialog } from "./Dialog.tsx";
import { formatBytes } from "./format.ts";

interface Props {
  prompt: TransferView | undefined;
  more: number;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
}

export function IncomingDialog({ prompt, more, onAccept, onDecline }: Props) {
  return (
    <Dialog open={prompt !== undefined} onCancel={() => prompt && onDecline(prompt.id)} label="Incoming files">
      {prompt && (
        <div data-testid="incoming-dialog">
          <h2 className="text-lg font-semibold">
            <span className="text-accent">{prompt.peerName}</span> wants to send you {prompt.files.length === 1 ? "a file" : `${prompt.files.length} files`}
          </h2>
          <ul className="mt-4 max-h-48 space-y-1.5 overflow-y-auto text-sm">
            {prompt.files.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <FileIcon className="size-4 shrink-0 text-mist" aria-hidden />
                <span className="min-w-0 flex-1 truncate" data-testid="incoming-file">
                  {f.name}
                </span>
                <span className="shrink-0 text-mist">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          {prompt.files.length > 1 && <p className="mt-2 text-sm text-mist">Total {formatBytes(prompt.total)}</p>}

          <div className="mt-5 flex items-center gap-3 rounded-xl bg-ink p-3">
            <ShieldCheck className="size-6 shrink-0 text-accent" aria-hidden />
            <div>
              <p className="font-mono text-2xl tracking-widest" data-testid="incoming-sas">
                {prompt.sas}
              </p>
              <p className="text-xs text-mist">End-to-end encrypted. To be sure it's really them, check that the sender sees the same code.</p>
            </div>
          </div>

          {more > 0 && <p className="mt-3 text-xs text-mist">{more} more request(s) waiting</p>}
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={() => onDecline(prompt.id)} className="rounded-lg px-4 py-2 font-medium text-mist hover:bg-ink hover:text-fg">
              Decline
            </button>
            <button
              type="button"
              autoFocus
              data-testid="accept"
              onClick={() => onAccept(prompt.id)}
              className="rounded-lg bg-accent px-4 py-2 font-semibold text-ink hover:brightness-110"
            >
              Accept
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
