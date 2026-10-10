import { useEffect, useRef, type ReactNode } from "react";

/** Native modal <dialog>: focus trapping, Esc and inertness come for free. */
export function Dialog({ open, onCancel, label, children }: { open: boolean; onCancel: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-ink-line bg-ink-raised p-6 text-white shadow-2xl"
    >
      {open && children}
    </dialog>
  );
}
