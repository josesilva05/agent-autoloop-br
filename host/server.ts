// O que as portas do kernel precisam desta máquina: o relógio, um temporizador para o próximo prazo, esperas longas a
// acordar, o arquivo de regras a observar, o log como stream e os plugins de webhook.
import { realpathSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { loadPlugin } from "./plugins.ts";
import * as hub from "./runtime.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { createHandler } from "../kernel/http.ts";

/** Além disto, o setTimeout dispara imediatamente. */
const LONGEST_TIMER = 2147483647;
const TICK_RETRY = 5_000;

function logStream(after: number, signal: AbortSignal, key: string) {
  let position = after;
  let unsubscribe = () => {};
  let stop = () => {};
  const detach = () => {
    unsubscribe();
    signal.removeEventListener("abort", stop);
  };
  let send = () => {};
  let stopped = false;
  return new ReadableStream({
    start(controller) {
      stop = () => {
        if (stopped) return;
        stopped = true;
        detach();
        controller.close();
      };
      send = () => {
        if (stopped) return;
        if (!hub.whose("owner", key)) return stop();
        if (controller.desiredSize! <= 0) return;
        for (const fact of hub.logAfter(position, 1)) {
          position = fact.seq;
          const message = `id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`;
          controller.enqueue(new TextEncoder().encode(message));
        }
      };
      unsubscribe = hub.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    pull() {
      send();
    },
    cancel() {
      stopped = true;
      detach();
    },
  });
}

async function adaptWebhook(source: string, headers: Headers, body: string) {
  const adapter = hub.rules.sources[source]?.adapter;
  if (!adapter || !/^[a-z][a-z0-9-]*$/.test(adapter)) throw new NotFound("esta fonte não aceita Webhook");
  const translate = await loadPlugin(adapter, "source");
  const secret = process.env[`AGENT_AUTOLOOP_SECRET_${source.toUpperCase().replaceAll("-", "_")}`] ?? "";
  try {
    const events = translate({ headers: Object.fromEntries(headers), body, secret });
    return Array.isArray(events) ? events : [];
  } catch {
    throw new AuthError("a verificação de assinatura falhou");
  }
}

export function makeHandler(commit = "dev") {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let retryAt: number | undefined;
  const waiting = new Set<{ until: number; done: () => void }>();
  const wake = () => {
    for (const waiter of [...waiting]) waiter.done();
  };
  const fire = () => {
    try {
      hub.tick();
      retryAt = undefined;
    } catch (error) {
      // Por exemplo, outro processo segurando o banco por tempo demais. Não há ninguém para capturá-lo, e o que ele
      // trouxe continua vencido.
      console.error(error);
      retryAt = Date.now() + TICK_RETRY;
    }
    wake();
    arm();
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    const due = hub.one<{ at: number }>(
      "SELECT MIN(json_extract(data, '$.at')) AS at FROM projections WHERE collection='due'",
    );
    // O que o tick que falhou deixou para trás já está atrasado, então sairia de imediato; e nada mais que apareça pode
    // fazer a nova tentativa se perder.
    const next = retryAt ?? Math.min(due?.at ?? Infinity, ...[...waiting].map((waiter) => waiter.until));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(fire, Math.max(0, Math.min(LONGEST_TIMER, next - Date.now())));
  };
  const unlisten = hub.onChange((type, facts) => {
    // Ser visto não acorda ninguém, a menos que tenha mudado um cartão.
    const justSeen = type === "heartbeat" || type === "channelSeen";
    if (!justSeen || facts.some((fact) => fact.changes.some((change) => change.table === "cards"))) wake();
    arm();
  });
  // No Windows, o libuv 1.52 (Node 24.16+) falha numa asserção e sai na primeira mudança numa pasta nomeada por um nome curto 8.3.
  const watcher = watch(realpathSync.native(dirname(RULES_FILE)), (_event, file) => {
    if (file === basename(RULES_FILE)) fire();
  });
  const handle = createHandler({
    commit,
    now: Date.now,
    view: hub.getView,
    environment: hub.environment,
    dispatch: hub.execute,
    state: hub.stateOf,
    skipped: hub.skipped,
    why: hub.why,
    card: hub.cardByToken,
    wait(until, signal) {
      return new Promise((resolve) => {
        const waiter = {
          until,
          done() {
            waiting.delete(waiter);
            signal.removeEventListener("abort", waiter.done);
            resolve();
          },
        };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.done, { once: true });
        if (signal.aborted) waiter.done();
        arm();
      });
    },
    stream: logStream,
    adapt: adaptWebhook,
  });
  fire();
  return {
    handle,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      unlisten();
      wake();
    },
  };
}
