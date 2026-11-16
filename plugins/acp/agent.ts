import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import { tail, type Adapter, type Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "bridge.ts"),
    JSON.stringify(turn),
  ],
  read(stdout, code, stderr) {
    let reading: Reading = {};
    for (const line of stdout.trim().split("\n")) {
      try {
        reading = { ...reading, ...JSON.parse(line) };
      } catch {
        /* Uma linha final incompleta é lida de novo depois da próxima consulta. */
      }
    }
    // O bridge desfaz isto quando o Agent recusa a sessão na qual deveria continuar.
    if (!reading.started) delete reading.started;
    if (code !== null && (code !== 0 || !reading.finished || reading.error)) {
      // Primeiro o que o próprio Agent disse, depois o motivo da falha. O bridge diz isso por último, a menos que o
      // Agent tenha continuado falando.
      const said = tail(stderr);
      const error = said.endsWith(reading.error ?? "") ? said : tail(`${said}\n${reading.error}`);
      return { session: reading.session, started: reading.started, error: error || "O ACP não concluiu esta rodada" };
    }
    return reading;
  },
} satisfies Adapter;
