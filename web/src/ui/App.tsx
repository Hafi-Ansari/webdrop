import { Link2, Radar, Wifi } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { Controller } from "../lib/controller.ts";
import { IncomingDialog } from "./IncomingDialog.tsx";
import { PairDialog } from "./PairDialog.tsx";
import { PeerCard } from "./PeerCard.tsx";
import { Toasts } from "./Toasts.tsx";
import { TransferList } from "./TransferList.tsx";

const CONNECTION = {
  open: { dot: "bg-success", label: "Online" },
  connecting: { dot: "bg-amber-400 animate-pulse", label: "Connecting…" },
  offline: { dot: "bg-danger", label: "Offline — reconnecting" },
} as const;

export function App({ controller }: { controller: Controller }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get);
  const [pairOpen, setPairOpen] = useState(false);
  const conn = CONNECTION[state.connection];

  const sendingTo = new Map<string, number>();
  for (const t of state.transfers) {
    if (t.direction === "out" && (t.state === "active" || t.state === "offered") && !sendingTo.has(t.peerId)) {
      sendingTo.set(t.peerId, t.total ? t.bytes / t.total : 0);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Radar className="size-6 text-accent" aria-hidden />
          WebDrop
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-xs text-mist" data-testid="connection" data-state={state.connection}>
            <span className={`size-2 rounded-full ${conn.dot}`} aria-hidden />
            {conn.label}
          </span>
          <button
            type="button"
            onClick={() => setPairOpen(true)}
            data-testid="pair-open"
            className="flex items-center gap-1.5 rounded-lg border border-ink-line px-3 py-1.5 text-sm hover:border-accent hover:text-accent"
          >
            <Link2 className="size-4" aria-hidden />
            Pair device
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-8">
        {state.peers.length === 0 ? (
          <div className="max-w-md text-center">
            <h1 className="text-2xl font-semibold text-accent">Open WebDrop on other devices to send files</h1>
            <p className="mt-2 text-mist">
              Devices on the same network show up here automatically. On a different network?{" "}
              <button type="button" onClick={() => setPairOpen(true)} className="text-fg underline hover:text-accent">
                Pair with a code
              </button>
              .
            </p>
          </div>
        ) : (
          <>
            <h1 className="sr-only">Nearby devices</h1>
            <p className="mb-4 text-sm text-mist">Click a device to send files, or drop files on it.</p>
            <ul className="flex max-w-4xl flex-wrap justify-center gap-4" data-testid="peers">
              {state.peers.map((p) => (
                <PeerCard key={p.id} peer={p} progress={sendingTo.get(p.id)} onFiles={(files) => controller.sendFiles(p.id, files)} />
              ))}
            </ul>
          </>
        )}
      </main>

      <TransferList
        transfers={state.transfers}
        onCancel={(id) => controller.cancel(id)}
        onDismiss={(id) => controller.dismiss(id)}
        onSave={(id, i) => controller.save(id, i)}
      />

      <footer className="flex flex-col items-center gap-1 px-4 pb-6 pt-6 text-center">
        <div className="radar mb-4 size-14 rounded-full">
          <Wifi className="size-10 text-accent" aria-hidden />
        </div>
        <p>
          You are known as{" "}
          <strong className="text-accent" data-testid="self-name">
            {state.self?.name ?? "…"}
          </strong>
        </p>
        <p className="text-sm text-mist">
          You can be discovered by everyone on this network
          {state.pairCode && (
            <>
              {" "}
              and in pairing room <span className="font-mono text-fg">{state.pairCode}</span>
            </>
          )}
          .
        </p>
      </footer>

      <IncomingDialog
        prompt={state.prompts[0]}
        more={Math.max(0, state.prompts.length - 1)}
        onAccept={(id) => controller.accept(id)}
        onDecline={(id) => controller.decline(id)}
      />
      <PairDialog
        open={pairOpen}
        code={state.pairCode}
        onClose={() => setPairOpen(false)}
        onCreate={() => controller.createPairRoom()}
        onJoin={(code) => controller.joinPairRoom(code)}
        onLeave={() => controller.leavePairRoom()}
      />
      <Toasts toasts={state.toasts} onDismiss={(id) => controller.dismissToast(id)} />
    </div>
  );
}
