// O worker: numa máquina que nada alcança, ele continua vindo à central buscar trabalho e inicia um Agent para cada
// tarefa. Um Agent roda desacoplado, no seu próprio grupo de processos, escrevendo em arquivos, para que o worker possa
// parar e voltar e o encontre ainda em execução, ou já concluído. Uma tarefa é salva antes de qualquer coisa lenta
// acontecer; um resultado é salvo antes de ser entregue e fica até a central tê-lo recebido.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubError, type Hub } from "../protocol/client.ts";
import { HOME } from "../host/home.ts";
import { commandLine, processCommand } from "../host/command.ts";
import type { Job } from "../protocol/job.ts";
import { addUsage, type Notice, type Result } from "../protocol/validate.ts";
import { adapterFor, type Adapter, type Reading, type Turn, type Usage } from "./agents.ts";
import { promptFor, readMessage, repairPrompt, resultFrom } from "./contract.ts";
import { loadUsage, saveUsage, usageDelta } from "./usage.ts";

const RUNS = path.join(HOME, "worker", "runs");
const NOTHING: Usage = { input: 0, output: 0, cached: 0, cost: 0 };
const TIMEOUT_MINUTES = 180;
/** Um processo cujo turno já terminou mas que não sai recebe este tempo. */
const GRACE = 30_000;
/** Um processo a quem se pediu para parar recebe este tempo. */
const STOP_GRACE = 10_000;
const REPAIRS = 2;
const KEEP_DAYS = 14;
/** Um worker pode rodar por meses, então a limpeza não pode esperar ele iniciar de novo. */
const TIDY_EVERY = 60 * 60_000;
const WAIT = 50;
const PAUSE = 30_000;
const UNREACHABLE = 10 * 60_000;
const TELL_TRIES = 5;
/** O bastante de uma saída longa para achar o que está em cada ponta dela, enquanto roda. */
const HEAD = 64 * 1024;
const TAIL = 1024 * 1024;

type Entry = {
  run: number;
  token: string;
  attempt: number;
  job: Job;
  dir: string;
  prompt: string;
  turn: number;
  session: string;
  resume: string | null;
  repairs: number;
  triedFresh: boolean;
  usage?: Usage;
  usageBaseline?: Usage;
  pid?: number;
  launchedAt?: number;
  finishedAt?: number;
  told?: string;
  stopping?: number;
  why?: "cancel" | "timeout" | "finished";
  result?: Result;
};
export type WorkerHub = Pick<Hub, "work" | "started" | "result">;
export type WorkerOptions = {
  hub: WorkerHub;
  name: string;
  capacity?: number;
  log?: (line: string) => void;
  /** Executado quando a central fica dez minutos sem ser alcançada, com {text} dentro: nada mais consegue avisar o titular então. */
  unreachable?: string[];
  wait?: number;
  now?: () => number;
};

function save(entry: Entry) {
  const file = path.join(entry.dir, "entry.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** O quanto uma inicialização avançou o total da sua sessão. Uma que não continuou naquela sessão começou do zero. */
function sessionRise(entry: Entry, { session, sessionUsage }: Reading) {
  if (!session || !sessionUsage) return;
  saveUsage(entry.job.agent.use, session, sessionUsage);
  return usageDelta(sessionUsage, session === entry.resume ? entry.usageBaseline : NOTHING);
}

/** O que o ambiente do Agent recebe: nunca as chaves da central, e nada de uma sessão em que o próprio worker possa estar. */
function agentEnvironment(entry: Entry) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$))/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    AGENT_AUTOLOOP_HOME: HOME,
    AGENT_AUTOLOOP_RUN: String(entry.run),
    AGENT_AUTOLOOP_CONTEXT: path.join(entry.dir, "context.json"),
  };
}

const files = (entry: Entry) => ({
  out: path.join(entry.dir, `stdout-${entry.turn}.log`),
  err: path.join(entry.dir, `stderr-${entry.turn}.log`),
  exit: path.join(entry.dir, `exit-${entry.turn}`),
  command: path.join(entry.dir, `command-${entry.turn}.${process.platform === "win32" ? "json" : "sh"}`),
});
const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const marker = (entry: Entry) => `agent-autoloop-run:${entry.run}:${entry.attempt}:${entry.turn}`;

/** Se o processo da rodada ainda está em execução: false quando ele se foi, null quando não conseguimos olhar. */
async function alive(entry: Entry): Promise<boolean | null> {
  if (!entry.pid) return false;
  try {
    const command = await processCommand(entry.pid);
    return command.includes(marker(entry));
  } catch (error) {
    // Um processo que se foi faz o ps sair com status 1; qualquer outra coisa (EPERM, EACCES, uma falha
    // de spawn) significa que não conseguimos olhar, o que não é o mesmo que ele ter se ido.
    const status = (error as { code?: unknown }).code;
    if (process.platform !== "win32" && status === 1) return false;
    return null;
  }
}

function signal(entry: Entry, name: NodeJS.Signals) {
  try {
    if (entry.pid) process.kill(process.platform === "win32" ? entry.pid : -entry.pid, name);
  } catch {}
}

/** Se algo no grupo da rodada ainda está em execução, null quando não conseguimos olhar. */
async function groupAlive(entry: Entry): Promise<boolean | null> {
  // O wrapper pode morrer antes de um filho; zumbis já pararam e só o pai deles pode coletá-los.
  if (!entry.pid) return false;
  if (process.platform === "win32") return alive(entry);
  try {
    return execFileSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === entry.pid && !state.startsWith("Z");
      });
  } catch {
    // O próprio ps pode estar ausente ou bloqueado num sandbox. Este grupo foi iniciado aqui, então dá para perguntar
    // diretamente sobre ele: grupo inexistente significa que se foi, qualquer outra coisa significa que não deu para olhar.
    try {
      process.kill(-entry.pid, 0);
      return true;
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
    }
  }
}

function snapshot(file: string) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= HEAD + TAIL) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(HEAD);
    const end = Buffer.alloc(TAIL);
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, end, 0, TAIL, size - TAIL);
    return `${head.toString("utf8")}\n${end.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

export function createWorker({
  hub,
  name,
  capacity = 2,
  log = () => {},
  unreachable,
  wait = WAIT,
  now = Date.now,
}: WorkerOptions) {
  let claim = randomUUID();
  let unreachableSince: number | null = null;
  let told = false;
  let tries = 0;
  let blind = false;
  let tidied = -Infinity;
  const said = new Set<string>();
  /** Um problema que dura passa por aqui a cada segundo, e uma vez no log basta. */
  const sayOnce = (line: string) => {
    if (!said.has(line)) log(line);
    said.add(line);
  };
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });

  const entries = () =>
    readdirSync(RUNS).flatMap((id) => {
      try {
        return [JSON.parse(readFileSync(path.join(RUNS, id, "entry.json"), "utf8")) as Entry];
      } catch {
        return [];
      }
    });

  /** Inicia um turno do Agent: um processo que vive mais que este, deixando sua saída e código de saída em arquivos. */
  function launch(entry: Entry, adapter: Adapter, prompt: string) {
    entry.turn += 1;
    entry.launchedAt = now();
    entry.usageBaseline = entry.resume ? loadUsage(entry.job.agent.use, entry.resume) : undefined;
    delete entry.finishedAt;
    delete entry.pid;
    delete entry.stopping;
    delete entry.why;
    save(entry);
    const { rule, agent } = entry.job;
    const cwd = rule.cwd.replace(/^~(?=[/\\])/, homedir());
    const turn: Turn = {
      prompt,
      session: entry.session,
      resume: entry.resume,
      cwd,
      model: agent.model,
      effort: agent.effort,
      tier: agent.tier,
      access: agent.access as Turn["access"],
      command: agent.command,
      program: agent.program,
      contextFile: path.join(entry.dir, "context.json"),
      folder: entry.dir,
    };
    if (!existsSync(cwd)) throw new Error(`Não é possível iniciar em ${cwd}: esse diretório não existe`);
    const argv = adapter.command(turn);
    const { out, err, exit, command } = files(entry);
    if (process.platform === "win32") {
      writeFileSync(command, JSON.stringify({ argv, cwd, exit }), { mode: 0o600 });
      const output = openSync(out, "w");
      const errors = openSync(err, "w");
      try {
        const child = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            path.join(import.meta.dirname, "run.ts"),
            "--supervise",
            command,
            marker(entry),
          ],
          {
            cwd,
            env: { ...agentEnvironment(entry), AGENT_AUTOLOOP_NODE: process.execPath },
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output, errors],
          },
        );
        child.on("error", (error) => log(`rodada ${entry.run}: ${error}`));
        child.unref();
        entry.pid = child.pid;
      } finally {
        closeSync(output);
        closeSync(errors);
      }
      save(entry);
      log(`rodada ${entry.run} (${rule.name}) turno ${entry.turn} iniciada, pid ${entry.pid}`);
      return;
    }
    // Shells de login não concordam sobre como um comando lê seus argumentos (o fish não tem $0 nem $@), então o comando
    // espera num arquivo pelo /bin/sh. O caminho dele vai por variável de ambiente porque o caminho da instalação pode ter qualquer caractere.
    writeFileSync(command, `unset AGENT_AUTOLOOP_COMMAND\nexec ${argv.map(quoted).join(" ")}\n`, { mode: 0o600 });
    // A saída e o código de saída passam pelo shell, então chegam aos seus arquivos mesmo que este programa já tenha ido embora.
    const script = [
      "out=$1",
      "err=$2",
      "result=$3",
      "shift 3",
      "umask 077",
      '"$@" >"$out" 2>"$err"',
      'echo $? >"$result.tmp"',
      'mv "$result.tmp" "$result"',
      // Um comando externo final pode substituir o shell antes de ele publicar seu arquivo de saída.
      ":",
    ].join("\n");
    // O shell de login dá a ele o PATH e o login que o titular tem num terminal; launchd e systemd não dão nenhum dos dois.
    const login = [process.env.SHELL ?? "/bin/sh", "-lc", 'exec /bin/sh "$AGENT_AUTOLOOP_COMMAND"'];
    const child = spawn("/bin/sh", ["-c", script, marker(entry), out, err, exit, ...login], {
      cwd,
      env: { ...agentEnvironment(entry), AGENT_AUTOLOOP_COMMAND: command },
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => log(`rodada ${entry.run}: ${error}`));
    child.unref();
    entry.pid = child.pid;
    save(entry);
    log(`rodada ${entry.run} (${rule.name}) turno ${entry.turn} iniciada, pid ${child.pid}`);
  }

  function endWith(entry: Entry, result: Result) {
    entry.result = result;
    save(entry);
  }

  async function start(job: Job) {
    const dir = path.join(RUNS, `${job.run}-${job.attempt}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry: Entry = {
      run: job.run,
      token: job.token,
      attempt: job.attempt,
      job,
      dir,
      prompt: "",
      turn: 0,
      session: job.session ?? randomUUID(),
      resume: job.session,
      repairs: 0,
      triedFresh: false,
    };
    // Salvo antes de qualquer coisa lenta: um worker parado daqui em diante ainda tem a tarefa.
    save(entry);
    try {
      writeFileSync(path.join(dir, "context.json"), JSON.stringify(job.context, null, 2), { mode: 0o600 });
      const adapter = await adapterFor(job.agent.use);
      entry.prompt = promptFor(job, path.join(dir, "context.json"));
      save(entry);
      launch(entry, adapter, entry.prompt);
    } catch (error) {
      endWith(entry, { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) });
    }
  }

  function read(entry: Entry, adapter: Adapter, code: number | null): Reading {
    const { out, err } = files(entry);
    try {
      const reading = adapter.read(snapshot(out), code, code === null ? "" : snapshot(err));
      if (!reading) throw new Error("ele não deu nada");
      return reading;
    } catch (error) {
      sayOnce(`rodada ${entry.run}: não consegui ler a saída dele: ${error}`);
      // Uma que ainda está em execução continua, pois isto não diz nada sobre como ela vai. Se uma que já acabou chegou
      // a começar, não se sabe, e iniciá-la de novo em outra sessão poderia fazer o trabalho duas vezes: ela fica nesta.
      return { started: true, error: `Não entendi a saída deste Agent: ${(error as Error).message ?? error}` };
    }
  }

  function discardReceipt(entry: Entry, adapter: Adapter, problem: string) {
    const original = { ...entry, turn: entry.turn - entry.repairs };
    const reading = read(original, adapter, 0);
    const { result } = resultFrom(readMessage(reading.text ?? ""), {
      session: reading.session ?? (adapter.link ? entry.session : undefined),
      usage: entry.usage,
    });
    const notice: Notice = {
      title: `Não entendi o recibo de "${entry.job.rule.name}"`,
      text: `Esta rodada foi encerrada pela primeira linha, mas o que ela pediu à central não entrou em vigor (${problem}). O original está em ${files(original).out} e fica por ${KEEP_DAYS} dias.`,
    };
    endWith(entry, { ...result, notice: [...(result.notice ?? []), notice] });
  }

  /** Um turno acabou. O que ele disse é um resultado, ou um motivo para pedir de novo sem refazer nada. */
  function conclude(entry: Entry, adapter: Adapter, code: number | null) {
    // Uma que acabou porque o turno terminou mas ela não saía disse antes o que tinha a dizer.
    const seen = read(entry, adapter, entry.finishedAt ? 0 : code);
    entry.usage = addUsage(addUsage(entry.usage, seen.usage), sessionRise(entry, seen));
    const session = seen.session ?? (entry.turn > 0 && adapter.link ? entry.session : undefined);
    if (seen.session) entry.session = seen.session;
    const usage = entry.usage && { usage: entry.usage };
    const known = session && { session };
    if (entry.why === "cancel")
      return endWith(entry, { outcome: "cancelled", summary: "Interrompida", ...known, ...usage });
    if (entry.why === "timeout") {
      const minutes = entry.job.agent.timeout ?? TIMEOUT_MINUTES;
      const error = `Não terminou em ${minutes} minutos e foi interrompida`;
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      return endWith(entry, { outcome: "failed", error, ...known, ...usage });
    }
    if (seen.error !== undefined || !seen.text?.trim()) {
      const error = seen.error || "não deixou resultado";
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      // A conversa pode não estar lá para continuar, ou outra coisa a tem aberta: desta vez segue numa conversa nova.
      // Não depois que o turno começou: uma nova refaria o trabalho. A central tenta de novo mais tarde, nesta mesma.
      if (entry.resume && !entry.triedFresh && entry.repairs === 0 && !seen.started) {
        log(`rodada ${entry.run}: não deu para continuar em ${entry.resume} (${error}); abrindo uma sessão nova`);
        entry.triedFresh = true;
        entry.resume = null;
        entry.session = randomUUID();
        try {
          launch(entry, adapter, entry.prompt);
          return;
        } catch (failure) {
          return endWith(entry, { outcome: "failed", error: String(failure).slice(0, 500) });
        }
      }
      return endWith(entry, { outcome: "failed", error: error.slice(0, 500), ...known, ...usage });
    }
    const { result, problem } = resultFrom(readMessage(seen.text), { session, usage: entry.usage });
    if (entry.repairs && !problem && result.outcome === "failed") return discardReceipt(entry, adapter, result.error!);
    if (!problem) return endWith(entry, result);
    // O trabalho dele está feito e só o recibo está errado: ele escreve o recibo de novo e não refaz nada.
    if (entry.repairs < REPAIRS && seen.session) {
      log(`rodada ${entry.run}: recibo ilegível (${problem}); pedindo de novo`);
      entry.repairs += 1;
      entry.resume = seen.session;
      try {
        launch(entry, adapter, repairPrompt(problem));
        return;
      } catch (error) {
        return discardReceipt(entry, adapter, String(error));
      }
    }
    discardReceipt(entry, adapter, problem);
  }

  /** Olha uma rodada em mãos: ainda em execução, a ser interrompida, ou concluída. */
  async function check(entry: Entry) {
    if (entry.result) return;
    let adapter: Adapter;
    try {
      adapter = await adapterFor(entry.job.agent.use);
    } catch (error) {
      return endWith(entry, { outcome: "failed", error: String((error as Error).message).slice(0, 500) });
    }
    if (entry.turn === 0) {
      // O worker parou enquanto a iniciava, antes de qualquer coisa ser lançada.
      if (!entry.prompt) entry.prompt = promptFor(entry.job, path.join(entry.dir, "context.json"));
      try {
        writeFileSync(path.join(entry.dir, "context.json"), JSON.stringify(entry.job.context, null, 2), {
          mode: 0o600,
        });
        return launch(entry, adapter, entry.prompt);
      } catch (error) {
        return endWith(entry, { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) });
      }
    }
    const { exit } = files(entry);
    const exitCode = () => (existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null);
    if (entry.stopping !== undefined) {
      const going = await groupAlive(entry);
      const overdue = now() - entry.stopping > STOP_GRACE;
      if (going === true) {
        if (overdue) signal(entry, "SIGKILL");
        return;
      }
      if (going === null) {
        // A finalização forçada é a última coisa que se pode fazer com ela, e não dá para ver se funcionou.
        if (!overdue) return;
        signal(entry, "SIGKILL");
        // Um turno que já acabou, ou um estouro de tempo, termina no que ele disse: `failed` ali é tentado de novo, refazendo o trabalho feito.
        if (entry.why !== "cancel") return conclude(entry, adapter, exitCode());
        // Reportar `cancelled` liberaria o assunto enquanto um processo ainda pode estar nele, o que o protocolo proíbe
        // (docs/protocol.md: só se entrega cancelled depois de confirmar que não há processo vivo no grupo). O `failed` de uma rodada cancelada não é tentado de novo.
        return endWith(entry, {
          outcome: "failed",
          error: "Após a parada não confirmei o fim do grupo: falha, sem nova tentativa; o processo pode estar vivo.",
        });
      }
      return conclude(entry, adapter, exitCode());
    }
    if (existsSync(exit)) return conclude(entry, adapter, exitCode());
    // O shell pode publicar seu arquivo de saída entre a primeira checagem do arquivo e o retorno do ps.
    const looking = await alive(entry);
    if (looking === false) return conclude(entry, adapter, exitCode());
    // Sem conseguir olhar, a rodada conta como ainda em execução, então seu estouro de tempo e seu turno concluído ainda a encerram.
    if (looking === null && !blind) log(`não consigo inspecionar processos; rodadas valem como em execução até o fim`);
    blind = looking === null;
    const seen = read(entry, adapter, null);
    // Guardada assim que é lida: se o fim não puder ser lido, a que foi inventada ao iniciar pode não ser conhecida pelo CLI dele.
    if (seen.session && seen.session !== entry.session) {
      entry.session = seen.session;
      save(entry);
    }
    const session = seen.session ?? (adapter.link ? entry.session : undefined);
    if (session && session !== entry.told) {
      try {
        await hub.started(entry.run, entry.token, { session, ...(adapter.link && { link: adapter.link(session) }) });
        entry.told = session;
        save(entry);
      } catch (error) {
        log(`rodada ${entry.run}: não consegui avisar que começou: ${error}`);
      }
    }
    const moment = now();
    const limit = (entry.job.agent.timeout ?? TIMEOUT_MINUTES) * 60_000;
    if (moment - (entry.launchedAt ?? moment) > limit) return stop(entry, "timeout");
    if (seen.finished) {
      // O turno dele acabou mas ele não se foi: seja lá em que esteja preso, a resposta já está lá.
      if (!entry.finishedAt) {
        entry.finishedAt = moment;
        save(entry);
      } else if (moment - entry.finishedAt > GRACE) {
        stop(entry, "finished");
      }
    }
  }

  function stop(entry: Entry, why: NonNullable<Entry["why"]>) {
    if (entry.stopping !== undefined || entry.result) return;
    entry.stopping = now();
    entry.why = why;
    save(entry);
    signal(entry, "SIGTERM");
    log(`rodada ${entry.run}: interrompendo (${why})`);
  }

  /** Entrega o que terminou. Um que a central não pode receber agora espera a próxima vez; um que ela recusa é descartado, e isso é dito. */
  async function settle(entry: Entry) {
    if (!entry.result) return;
    try {
      const answer = await hub.result(entry.run, entry.token, entry.result);
      for (const item of answer?.rejected ?? []) log(`rodada ${entry.run}: não aplicado: ${JSON.stringify(item)}`);
      log(`rodada ${entry.run}: ${entry.result.outcome}`);
    } catch (error) {
      if (!(error instanceof HubError) || error.status >= 500) {
        return log(`rodada ${entry.run}: não consegui entregar o resultado: ${error}`);
      }
      log(`rodada ${entry.run}: a central recusou o resultado (${error.status}: ${error.message}); descartado`);
    }
    unlinkSync(path.join(entry.dir, "entry.json"));
  }

  /** Nada mais consegue avisar o titular quando o que caiu foi a central. */
  function watchHub(reachable: boolean, moment: number) {
    if (reachable) {
      unreachableSince = null;
      told = false;
      tries = 0;
      return;
    }
    unreachableSince ??= moment;
    if (!unreachable?.length || told || tries >= TELL_TRIES || moment - unreachableSince < UNREACHABLE) return;
    tries += 1;
    const minutes = Math.floor((moment - unreachableSince) / 60_000);
    const text = `${name} não alcança a central há ${minutes} minutos; o trabalho dele espera, e ele segue tentando.`;
    const [program, args] = commandLine(unreachable.map((part) => part.replaceAll("{text}", text)));
    try {
      execFileSync(program, args, { timeout: 60_000, stdio: "ignore" });
      told = true;
    } catch (error) {
      log(`não consegui avisar ninguém de que a central caiu: ${error}`);
    }
  }

  /** Um problema numa rodada, digamos uma pasta em que não dá para escrever, fica para a próxima volta e não segura nenhuma outra. */
  async function eachEntry(step: (entry: Entry) => Promise<unknown>) {
    for (const entry of entries()) {
      try {
        await step(entry);
      } catch (error) {
        sayOnce(`rodada ${entry.run}: ${error}`);
      }
    }
  }

  /** Uma volta: olhar o que está em mãos, entregar o que terminou, vir buscar mais. Diz se a central pôde ser alcançada. */
  async function tick() {
    // Aqui e não em run: seja lá o que mova o worker, passa por aqui.
    if (now() - tidied >= TIDY_EVERY) {
      tidied = now();
      tidy(tidied);
    }
    await eachEntry(check);
    await eachEntry(settle);
    const held = entries();
    let reachable = true;
    try {
      const answer = await hub.work({
        claim,
        wait: held.length ? 1 : wait,
        running: held.map((entry) => entry.run),
        capacity: held.length < capacity,
      });
      for (const id of answer?.cancel ?? []) {
        const entry = held.find((entry) => entry.run === id);
        if (entry) stop(entry, "cancel");
      }
      if (answer?.job) {
        claim = randomUUID();
        await start(answer.job);
      }
    } catch (error) {
      log(`não consegui alcançar a central: ${error}`);
      reachable = false;
    }
    watchHub(reachable, now());
    return reachable;
  }

  /** A saída de rodadas concluídas é guardada por um tempo para consulta, e depois vai embora. */
  function tidy(moment = now()) {
    for (const id of readdirSync(RUNS)) {
      const dir = path.join(RUNS, id);
      try {
        const expired = moment - statSync(dir).mtimeMs > KEEP_DAYS * 24 * 3600_000;
        if (!existsSync(path.join(dir, "entry.json")) && expired) rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        sayOnce(`não consegui limpar ${dir}: ${error}`);
      }
    }
  }

  async function run(signalled: AbortSignal) {
    log(`worker ${name} iniciado`);
    while (!signalled.aborted) {
      if (!(await tick())) await new Promise((resolve) => setTimeout(resolve, PAUSE));
    }
  }

  return { tick, run, entries, tidy };
}
