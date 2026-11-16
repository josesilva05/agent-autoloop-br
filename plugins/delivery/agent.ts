// A entrega como um Agent: seu processo é o run.ts, e o que ele imprime é lido do mesmo jeito que a saída de qualquer comando comum.
import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import command from "../command/agent.ts";
import type { Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "run.ts"),
    ...(turn.command ?? []),
  ],
  read: command.read,
} satisfies Adapter;
