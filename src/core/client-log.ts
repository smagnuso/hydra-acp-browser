// Fire-and-forget diagnostics from the page into the extension's log
// (~/.hydra-acp/extensions/hydra-acp-browser/current.log), for problems
// that only reproduce on a real phone. The server rate-limits and caps it.

export function clientLog(line: string): void {
  void fetch("/api/client-log", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ line }),
    keepalive: true,
  }).catch(() => undefined);
}
