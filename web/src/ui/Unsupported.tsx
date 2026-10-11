export function Unsupported({ secure }: { secure: boolean }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold text-accent">WebDrop can't run here</h1>
      <p className="text-mist">
        {secure
          ? "This browser is missing WebRTC or the Web Crypto API. Try a current version of Chrome, Edge, Firefox or Safari."
          : "End-to-end encryption needs a secure connection. Open this page over HTTPS (or on localhost)."}
      </p>
    </main>
  );
}
