import { useState } from "react";
import { normalizeCode } from "../lib/pairing.ts";
import { Dialog } from "./Dialog.tsx";
import { QrCode } from "./QrCode.tsx";

interface Props {
  open: boolean;
  code: string | null;
  onClose: () => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
}

export function PairDialog({ open, code, onClose, onCreate, onJoin, onLeave }: Props) {
  const [input, setInput] = useState("");
  const normalized = normalizeCode(input);
  const valid = /^[0-9A-HJKMNP-TV-Z]{6}$/.test(normalized);

  return (
    <Dialog open={open} onCancel={onClose} label="Pair a device">
      <h2 className="text-lg font-semibold">Pair with a device on another network</h2>
      <p className="mt-1 text-sm text-mist">Devices on the same Wi-Fi find each other automatically. Use a code to connect across networks.</p>

      {code ? (
        <div className="mt-5 flex flex-col items-center gap-3 rounded-xl bg-ink p-4">
          <p className="text-sm text-mist">Enter this code on the other device, or scan it:</p>
          <p className="font-mono text-4xl font-semibold tracking-[0.3em] text-accent" data-testid="pair-code">
            {code}
          </p>
          <QrCode value={`${location.origin}/#pair=${code}`} />
          <button type="button" onClick={onLeave} className="text-sm text-mist underline hover:text-fg">
            Stop pairing
          </button>
        </div>
      ) : (
        <button type="button" onClick={onCreate} className="mt-5 w-full rounded-lg bg-accent px-4 py-2 font-semibold text-ink hover:brightness-110" data-testid="pair-create">
          Show a pairing code
        </button>
      )}

      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onJoin(normalized);
          setInput("");
        }}
      >
        <label htmlFor="pair-input" className="text-sm font-medium">
          Have a code from another device?
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="pair-input"
            data-testid="pair-input"
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, 8))}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABC123"
            className="min-w-0 flex-1 rounded-lg border border-ink-line bg-ink px-3 py-2 font-mono uppercase tracking-widest outline-none focus:border-accent"
          />
          <button type="submit" disabled={!valid} className="rounded-lg bg-ink-line px-4 py-2 font-medium enabled:hover:bg-accent enabled:hover:text-ink disabled:opacity-50" data-testid="pair-join">
            Join
          </button>
        </div>
      </form>

      <div className="mt-6 flex justify-end">
        <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 font-medium text-mist hover:bg-ink hover:text-fg">
          Done
        </button>
      </div>
    </Dialog>
  );
}
