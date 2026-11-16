// Tudo o que esta máquina faz, num processo só: a central, o worker e seus canais, conforme o config.json diga. Aqui eles
// falam entre si o mesmo protocolo que falariam através do mundo. Parar deixa os Agents em execução: eles são desanexados,
// e o worker os encontra de novo quando voltar.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadChannel } from "./channels.ts";
import { cantListen, parseListen, readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { runningUp } from "./service.ts";
import { commitOf } from "./version.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);

/** Só um destes por instalação: um segundo pegaria trabalho ao lado do primeiro. */
function lock() {
  const running = runningUp();
  // O próprio número é o que ficou para trás: pid 1 toda vez num contêiner, e uma questão de sorte depois de reiniciar.
  if (running !== null && running !== process.pid) throw new Error(`já está em execução (processo ${running})`);
  const file = path.join(HOME, "up.pid");
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

/** secrets.env: o que um adaptador precisa para conferir um webhook, mantido fora do rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** O que roda ao lado da central é iniciado de novo seja como for que pare, depois de uma pausa: um que retornasse na hora a monopolizaria. */
async function keepRunning(say: (line: string) => void, run: () => Promise<unknown>, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await run();
      if (signal.aborted) return;
      say("parou; iniciando de novo em 30 segundos");
    } catch (error) {
      say(`parou: ${error}; iniciando de novo em 30 segundos`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

function keepChannelRunning(id: string, { use, key, ...options }: ChannelConfig, url: string, signal: AbortSignal) {
  const say = log(id);
  return keepRunning(
    say,
    async () => {
      const start = await loadChannel(use ?? id);
      await start({ hub: hubClient(url, key), options, log: say, signal });
    },
    signal,
  );
}

export async function up() {
  const config = readConfig();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const unlock = lock();
  // Os plugins rodam neste processo, e um evento `error` ou uma promise que ninguém tratou são responsabilidade deles,
  // não da central. Tudo o que importa está em transações, então o resto pode continuar.
  const stray = log("up");
  process.on("uncaughtException", (error) => stray(`erro desgarrado: ${error?.stack ?? error}`));
  process.on("unhandledRejection", (error) => stray(`erro desgarrado: ${(error as Error)?.stack ?? error}`));
  // Exceto perder o destino do log: registrar isso falha do mesmo jeito, para sempre. Ele para, e um serviço o traz de volta.
  for (const output of [process.stdout, process.stderr]) output.on("error", () => process.exit(1));
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  if (config.hub) {
    loadSecrets();
    const { host, port } = parseListen(config.hub.listen);
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      say(
        `${host} não é um endereço de loopback local: a central ficará aberta para a rede desse endereço. É preciso ter um proxy reverso HTTPS na frente`,
      );
    }
    const server = serve(port, host, { commit: commitOf() });
    server.on("listening", () => say(`escutando em ${config.hub!.listen}`));
    server.on("error", (error) => {
      say(cantListen(error));
      process.exit(1);
    });
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }
  if (config.worker) {
    const { key, name, capacity, unreachable } = config.worker;
    const say = log("worker");
    const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: say });
    jobs.push(keepRunning(say, () => worker.run(stop.signal), stop.signal));
  }
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    jobs.push(keepChannelRunning(id, channel, config.url, stop.signal));
  }
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  await Promise.all(jobs);
}
