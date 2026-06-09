import { startWatchService } from "../runtime/watch-service.js";
import { renderTerminalGraph } from "./graph-renderer.js";

export function startTerminalLive({ repoPath, interval = 1500, color = true, clear = true, renderer }) {
  let last = null;
  const renderGraph = renderer || renderTerminalGraph;

  function renderFrame(analysis, reason = "manual") {
    last = analysis;
    if (clear) clearScreen();
    process.stdout.write(renderGraph(analysis, { color }));
    process.stdout.write(`\nmode: live  reason=${reason}  interval=${interval}ms  press Ctrl+C to stop\n`);
  }

  const service = startWatchService({
    repoPath,
    scanInterval: interval,
    onAnalysis: renderFrame,
    onError(error, reason) {
      if (clear) clearScreen();
      process.stderr.write(`[scopelease:${reason}] ${error.stack || error.message}\n`);
      if (last) process.stdout.write(renderGraph(last, { color }));
    }
  });

  process.on("SIGINT", () => {
    service.close();
    process.stdout.write("\n");
    process.exit(0);
  });

  return service;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}
