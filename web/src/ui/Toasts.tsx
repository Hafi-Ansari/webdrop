import { X } from "lucide-react";
import type { Toast } from "../lib/controller.ts";

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-10 flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${t.kind === "error" ? "border-danger/40 bg-ink-raised text-danger" : "border-ink-line bg-ink-raised"}`}
        >
          <span className="flex-1">{t.text}</span>
          <button type="button" onClick={() => onDismiss(t.id)} aria-label="Dismiss" className="text-mist hover:text-white">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
