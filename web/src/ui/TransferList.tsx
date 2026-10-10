import { ArrowDownToLine, ArrowUpFromLine, Download, RotateCw, X } from "lucide-react";
import type { TransferView } from "../lib/controller.ts";
import { formatBytes, formatEta, formatRate, summarizeFiles } from "./format.ts";

interface Props {
  transfers: TransferView[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onSave: (id: string, index: number) => void;
}

const STATE_LABEL: Record<TransferView["state"], (t: TransferView) => string> = {
  connecting: () => "Connecting…",
  offered: () => "Waiting for them to accept…",
  active: (t) => (t.direction === "out" ? "Sending" : "Receiving"),
  interrupted: () => "Connection lost — will resume automatically",
  done: (t) => (t.direction === "out" ? "Sent" : "Received"),
  declined: () => "Declined",
  cancelled: () => "Cancelled",
  failed: (t) => `Failed${t.error ? `: ${t.error}` : ""}`,
};

const FINAL = new Set(["done", "declined", "cancelled", "failed"]);

export function TransferList({ transfers, onCancel, onDismiss, onSave }: Props) {
  if (transfers.length === 0) return null;
  return (
    <section aria-label="Transfers" className="mx-auto w-full max-w-2xl px-4 pb-2">
      <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
        {transfers.map((t) => (
          <TransferRow key={t.id} t={t} onCancel={onCancel} onDismiss={onDismiss} onSave={onSave} />
        ))}
      </ul>
    </section>
  );
}

function TransferRow({ t, onCancel, onDismiss, onSave }: { t: TransferView } & Omit<Props, "transfers">) {
  const final = FINAL.has(t.state);
  const Icon = t.direction === "out" ? ArrowUpFromLine : ArrowDownToLine;
  const pct = t.total > 0 ? t.bytes / t.total : t.state === "done" ? 1 : 0;
  const tone = t.state === "failed" ? "text-danger" : t.state === "done" ? "text-leaf" : "text-mist";

  return (
    <li className="rounded-xl border border-ink-line bg-ink-raised p-3" data-testid="transfer" data-state={t.state} data-direction={t.direction}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-leaf" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="text-mist">{t.direction === "out" ? "To" : "From"} </span>
            <span className="font-medium">{t.peerName}</span>
            <span className="text-mist">
              {" "}
              · {summarizeFiles(t.files)} ({formatBytes(t.total)})
            </span>
          </p>
          {!final && (
            <progress
              max={1}
              value={pct}
              aria-label="Progress"
              className="mt-2 h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-leaf [&::-webkit-progress-bar]:bg-ink [&::-webkit-progress-value]:bg-leaf"
            />
          )}
          <p className={`mt-1 text-xs ${tone}`} data-testid="transfer-status">
            {STATE_LABEL[t.state](t)}
            {t.state === "active" && (
              <>
                {" "}
                · {Math.floor(pct * 100)}% · {formatRate(t.rate)} {formatEta(t.total - t.bytes, t.rate) && `· ${formatEta(t.total - t.bytes, t.rate)}`}
              </>
            )}
            {t.sas && !final && <span className="text-mist"> · code {t.sas}</span>}
          </p>
          {t.direction === "in" && t.state === "done" && t.files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {t.files.map((f, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSave(t.id, i)}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-ink px-2 py-1 text-xs hover:bg-ink-line"
                  title={t.saved.includes(i) ? "Save again" : "Save"}
                >
                  {t.saved.includes(i) ? <RotateCw className="size-3" aria-hidden /> : <Download className="size-3" aria-hidden />}
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => (final ? onDismiss(t.id) : onCancel(t.id))}
          aria-label={final ? "Dismiss" : "Cancel transfer"}
          data-testid={final ? "dismiss" : "cancel"}
          className="rounded-md p-1 text-mist hover:bg-ink hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}
