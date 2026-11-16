// Um processo só detém a central, o worker e os canais, e os plugins rodam dentro dele. Casos de falha: um plugin de
// Agent que não consegue ler o que imprimiu encerra o processo, e o encerra de novo a cada inicialização porque a rodada
// ainda está lá; um plugin de canal que retorna de imediato entra em ciclo sem pausa e a central nunca mais responde, com
// o processo vivo e portanto nada o reiniciando; um throw desgarrado ou uma rejeição não tratada de um plugin de canal
// encerra o processo; o banco segurado tempo demais por outro processo faz um tick lançar a partir de um temporizador e
// encerra o processo, a mudança de regras que aquele tick trouxe se perde, a nova tentativa se perde para o que aparecer
// antes dela, ou regras escritas errado nesse intervalo nunca são avisadas; um worker que para não é iniciado de novo;
// perder o destino do log faz o erro sobre isso entrar em ciclo para sempre, com a central sem responder.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const homes: string[] = [];
const running: ChildProcess[] = [];
after(async () => {
  for (const child of running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  // O Windows não remove uma pasta em que um processo vivo trabalha, e um Agent solto há pouco pode ainda não ter saído.
  for (const home of homes) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } finally {
      rmSync(home + ".signals", { recursive: true, force: true });
    }
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const edit = (file: string, change: (value: any) => void) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** Uma instalação real num home só seu, sem o canal de desktop, com estes plugins na sua pasta. */
async function install(plugins: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-plugin-trouble-"));
  homes.push(home);
  const notifiers = join(home, "notifiers");
  mkdirSync(notifiers);
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(notifiers, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(notifiers, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    PATH: `${notifiers}${delimiter}${process.env.PATH}`,
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  const installed = cli("init", "--command", "node {prompt}", "--port", String(port), "--no-service");
  assert.equal(installed.status, 0, installed.stderr);
  for (const [file, code] of Object.entries(plugins)) {
    mkdirSync(join(home, "plugins", file.split("/")[0]), { recursive: true });
    writeFileSync(join(home, "plugins", file), code);
  }
  edit(join(home, "rules.json"), (rules) => (rules.channels = {}));
  edit(join(home, "config.json"), (config) => delete config.channels);
  const log = join(home, "up.log");
  writeFileSync(log, "");
  const up = () => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    child.stderr!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    running.push(child);
    return child;
  };
  return { home, port, cli, up, said: () => readFileSync(log, "utf8") };
}

/** Cada um numa conexão própria: uma central que parou de responder não pode parecer uma reutilizada que fechou. */
async function answers(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function until(done: () => boolean | Promise<boolean>, what: string, patience = 20_000) {
  const end = Date.now() + patience;
  while (!(await done())) {
    if (Date.now() > end) assert.fail(`não chegou: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

test("um plugin de Agent que não consegue ler o que imprimiu faz aquela rodada falhar, e a central continua de pé", async () => {
  // O próprio Node imprime, então o programa realmente roda em todo lugar: não existe /bin/echo no Windows.
  const it = await install({
    "unreadable/agent.ts": `export default {
      command: () => [${JSON.stringify(process.execPath)}, "-e", "console.log('ok')"],
      read() { throw new Error("no idea what this says"); },
    };`,
  });
  edit(join(it.home, "rules.json"), (rules) => {
    for (const agent of Object.values<any>(rules.agents)) {
      agent.use = "unreadable";
      delete agent.command;
    }
  });
  const up = it.up();
  await until(() => answers(it.port), "a central responder");
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  const owner = () => JSON.parse(readFileSync(join(it.home, "config.json"), "utf8")).owner as string;
  const firstRun = async () => {
    const response = await fetch(`http://127.0.0.1:${it.port}/v1/state`, {
      headers: { authorization: `Bearer ${owner()}`, connection: "close" },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    return response?.ok ? (await response.json()).runs.at(-1) : undefined;
  };
  await until(async () => alive(up) === false || (await firstRun())?.attempts === 1, "esta rodada contar como falha");
  assert.equal(alive(up), true, it.said());
  assert.match((await firstRun()).error, /Não entendi a saída deste Agent/);
  assert.equal(await answers(it.port), true);
});

test("um plugin de canal que retorna de imediato não impede a central de responder", async () => {
  const it = await install({ "quick/channel.ts": "export default async function quick() {}" });
  const key = it.cli("key", "new", "channel", "quick").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { quick: { use: "quick", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { quick: { name: "rápido" } }));
  const up = it.up();
  await until(() => answers(it.port), "a central responder");
  assert.equal(alive(up), true);
  await until(() => it.said().includes("[quick] parou"), "o log dizer que o canal parou");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(it.said().split("[quick] parou").length - 1, 1, "ele espera antes de ir de novo");
});

test("um worker que para é iniciado de novo, e a central continua de pé", async (t) => {
  // Uma rodada que termina sozinha não deixa nada em mão, e um worker ocioso então espera seus cinquenta segundos de
  // poll inteiros antes de olhar a pasta de novo — por isso esta aqui mantém a rodada aberta até o teste escrever
  // `release`, e a pasta só quebra depois que ela diz que iniciou. O limite de dois minutos serve apenas para que uma
  // asserção que falhe antes daquela escrita não o deixe consultando um arquivo que ninguém vai escrever.
  const hold = `const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const signals = process.env.AGENT_AUTOLOOP_HOME + ".signals";
const release = join(signals, "release");
const giveUp = Date.now() + 120_000;
try { writeFileSync(join(signals, "started"), ""); } catch {}
const look = () => (existsSync(release) || Date.now() > giveUp ? process.exit(0) : setTimeout(look, 50));
look();`;
  const it = await install({
    "busy/agent.ts": `const hold = ${JSON.stringify(hold)};
export default { command: () => [process.execPath, "-e", hold], read: () => ({}) };`,
  });
  edit(join(it.home, "rules.json"), (rules) => {
    for (const agent of Object.values<any>(rules.agents)) {
      agent.use = "busy";
      delete agent.command;
    }
  });
  // Ao lado do home, não dentro dele: a limpeza remove o home, e no Windows um sinal dentro dele vai primeiro, deixando
  // o Agent segurando a pasta até o seu limite de dois minutos. O Agent só escreve aqui, então um que saia tarde não deixa nada para trás.
  const signals = it.home + ".signals";
  mkdirSync(signals);
  // O Agent sobrevive a um worker parado por projeto, então isto o libera, quer o teste tenha chegado lá ou não.
  t.after(() => writeFileSync(join(signals, "release"), ""));
  const up = it.up();
  await until(() => answers(it.port), "a central responder");
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  const runs = join(it.home, "worker", "runs");
  // Iniciada e não apenas prestes a iniciar: uma que não consegue escrever na sua pasta enquanto inicia conta como
  // central fora de alcance, e isso espera 30 segundos antes da próxima rodada.
  await until(() => it.said().includes("turno 1 iniciada"), "esta rodada iniciar");
  // O log diz isso antes de o lançamento terminar, e no Windows isso leva dez vezes mais que o passo abaixo.
  await until(() => existsSync(join(signals, "started")), "o Agent ter sido iniciado");
  // Com uma rodada em mão ele volta a cada segundo, e algo no caminho da sua pasta impede a próxima rodada.
  rmSync(runs, { recursive: true, force: true });
  writeFileSync(runs, "");
  await until(() => alive(up) === false || it.said().includes("[worker] parou"), "o log dizer que o worker parou");
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
});

test("sem nenhum lugar para escrever, ele para, como sempre fez, em vez de entrar em ciclo no erro", async () => {
  const it = await install({
    "stray/channel.ts": `export default async function stray({ signal }) {
      const noisy = setInterval(() => { throw new Error("thrown out of reach"); }, 100);
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      clearInterval(noisy);
    }`,
  });
  const key = it.cli("key", "new", "channel", "stray").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { stray: { use: "stray", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { stray: { name: "bagunça" } }));
  const up = it.up();
  await until(() => it.said().includes("thrown out of reach"), "o log registrar o throw");
  up.stdout!.destroy();
  up.stderr!.destroy();
  await until(() => !alive(up), "o processo sair");
  assert.equal(up.exitCode, 1);
});

test("o throw desgarrado e a rejeição não tratada de um plugin de canal continuam sendo problema só dele", async () => {
  const it = await install({
    "stray/channel.ts": `export default async function stray({ signal }) {
      setTimeout(() => { throw new Error("thrown out of reach"); }, 200);
      setTimeout(() => { Promise.reject(new Error("rejected with nobody listening")); }, 300);
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    }`,
  });
  const key = it.cli("key", "new", "channel", "stray").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { stray: { use: "stray", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { stray: { name: "bagunça" } }));
  const up = it.up();
  await until(() => alive(up) === false || it.said().includes("thrown out of reach"), "o log registrar o throw");
  await until(
    () => alive(up) === false || it.said().includes("rejected with nobody listening"),
    "o log registrar a Promise que ninguém tratou",
  );
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
});

/** Uma central real cujo banco outro processo segura enquanto suas regras mudam, até o tick que as trouxe ter falhado. */
async function heldWhileRulesChange(
  change: (rules: any) => void,
  { before = (_home: string) => {}, failures = 1 } = {},
) {
  const it = await install();
  before(it.home);
  const up = it.up();
  await until(() => answers(it.port), "a central responder");
  const db = new DatabaseSync(join(it.home, "hub.db"));
  db.exec("BEGIN IMMEDIATE");
  // Movido para o lugar, para que o observador veja uma mudança só e nenhum segundo tick fique esperando o lock ao ser liberado.
  const file = join(it.home, "rules.json");
  const rules = JSON.parse(readFileSync(file, "utf8"));
  change(rules);
  writeFileSync(`${file}.new`, JSON.stringify(rules, null, 2));
  renameSync(`${file}.new`, file);
  const failed = () => it.said().split("Error: database is locked").length - 1;
  await until(() => alive(up) === false || failed() >= failures, "esta vez o prazo falhar", 30_000);
  db.exec("ROLLBACK");
  const askFirst = () => {
    const row = db.prepare("SELECT data FROM projections WHERE collection='config' AND key='rules'").get()!;
    return JSON.parse(String(row.data)).value.askFirst as string[];
  };
  const cards = () =>
    db
      .prepare("SELECT data FROM projections WHERE collection='cards'")
      .all()
      .map((row) => JSON.parse(String(row.data)).title as string);
  const landed = async () => {
    assert.equal(alive(up), true, it.said());
    assert.equal(await answers(it.port), true);
    db.close();
  };
  return { it, up, askFirst, cards, landed };
}

test("o banco segurado tempo demais por outro processo faz um tick falhar, não a central, e a mudança ainda assim chega", async () => {
  const { up, askFirst, landed } = await heldWhileRulesChange((rules) => (rules.askFirst = ["perguntar só isto"]));
  await until(() => alive(up) === false || askFirst()[0] === "perguntar só isto", "as regras novas valerem");
  await landed();
});

test("o que aparecer enquanto um tick que falhou espera para ir de novo não o perde", async () => {
  // Sem um worker perguntando, a única outra coisa a vencer é o cartão sobre isso, dez minutos adiante. A segunda falha
  // é a que se deve esperar: um observador de arquivos pode reportar uma mudança duas vezes, e um tick esperando o lock
  // seguiria assim que ele fosse liberado.
  const { it, up, askFirst, landed } = await heldWhileRulesChange((rules) => (rules.askFirst = ["perguntar só isto"]), {
    before: (home) => edit(join(home, "config.json"), (config) => delete config.worker),
    failures: 2,
  });
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  await until(() => alive(up) === false || askFirst()[0] === "perguntar só isto", "as regras novas valerem");
  await landed();
});

test("regras escritas errado enquanto o banco está segurado são avisadas assim que ele libera", async () => {
  const { up, cards, landed } = await heldWhileRulesChange((rules) => (rules.rules[0].to = "nobody"));
  await until(
    () => alive(up) === false || cards().includes("o rules.json está com erro; as regras antigas continuam em uso"),
    "avisar o titular de que as regras estão com erro",
  );
  await landed();
});
