// A linha de comando: o que uma pessoa, ou o Agent dela, digita.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../protocol/client.ts";
import { parseRules } from "../protocol/rules.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { findOnPath, psQuote } from "../host/command.ts";
import { privateDirectory } from "../host/files.ts";
import {
  aboveDesktop,
  installService,
  removeService,
  restartService,
  runningUp,
  serviceLogs,
  serviceRunning,
  startupInstead,
  systemUnit,
  untilAnswering,
} from "../host/service.ts";
import { versionLine } from "../host/version.ts";
import { clockFor, colorFor, render, replayCommand, skippedLine } from "./status.ts";
import { attemptsOf, newFailure, waitingRetry } from "./try.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROGRAM = path.join(ROOT, "bin", "agent-autoloop.ts");

const HELP = `Central de automação de Agents

  agent-autoloop init [--agent claude|codex] [--command 'um comando {prompt}'] [--port 3350] [--no-service]
                                    Instala nesta máquina: uma pessoa e um computador já bastam
  agent-autoloop try                       Percorre o fluxo completo com o seu Agent
  agent-autoloop why <nº da rodada> [--json]
                                    Mostra a linha do tempo; --json imprime os fatos brutos
  agent-autoloop conformance <endereço> --config <arquivo de credenciais de teste>
                                    Verifica o protocolo numa central de teste
  agent-autoloop status [--json]           Como estão as coisas agora: quem está online, o que espera por você,
                                     o que está em andamento, o que já foi feito e quanto custou
                                     --json imprime a estrutura bruta de /v1/state, para scripts
  agent-autoloop runs [regra] [--before <nº da rodada>] [--json]
                                    Lista as rodadas concluídas; dá para ver só uma regra e voltar páginas;
                                    use why para os detalhes
  agent-autoloop answer <cartão> [número] [--text outra ideia]
                                    Responde a um cartão; notificações não precisam de número
  agent-autoloop resolve <cartão> <resultado>
                                    Este assunto não precisa mais de decisão; escreva o resultado em uma frase
  agent-autoloop doctor                    Verifica o que está mal configurado
  agent-autoloop check [arquivo]           Confere um arquivo de regras sem tocar na central; sem arquivo, confere o rules.json
  agent-autoloop rules explain [arquivo]   Explica, pelo rules.json desta máquina (ou por um rascunho), as regras em vigor,
                                    os Agents, os canais e o próximo agendamento
  agent-autoloop pause <regra> [--reason motivo] [--until horário]
                                    Pausa uma regra: não dispara no horário, não recebe eventos nem os enfileira, até ser retomada
  agent-autoloop resume <regra>
                                    Retoma e lista os eventos ignorados durante a pausa; os períodos perdidos não são reexecutados
  agent-autoloop replay <regra> --since <horário>
                                    Reexecuta os eventos que esta regra ignorou desde aquele horário durante a pausa,
                                    cada um uma única vez
  agent-autoloop run <regra> [--subject objeto] [--reason descrição]
                                    Executa uma rodada imediatamente, entrando na fila e sendo despachada normalmente
  agent-autoloop emit <tipo> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key chave da fonte]
                                    Envia um evento; --dry-run só simula para quem ele iria, sem conectar à central
  agent-autoloop tell <número> [--task nome da tarefa agendada]
                                    Comunica um assunto diretamente a você; o texto é lido da entrada padrão
  agent-autoloop ask --task <nome da tarefa agendada>
                                    Uma tarefa agendada pergunta algo a você: a entrada padrão recebe um ask como o de um
                                    recibo; respondida, o Agent dela continua no cwd
  agent-autoloop stop <nº da rodada>       Interrompe uma rodada
  agent-autoloop key new <source|worker|channel|owner> <nome>
                                    Cria uma chave nova (mostrada só desta vez)
  agent-autoloop key list                  Quais chaves existem
  agent-autoloop key remove <tipo> <nome>  Revoga uma chave imediatamente
  agent-autoloop add <url git>             Instala um plugin, sem atualização automática
  agent-autoloop mcp                         Conecta um cliente MCP pela entrada e saída padrão
  agent-autoloop join <endereço da central> --worker <nome> --key <chave> [--no-service]
                                    Para quando outro computador só executa trabalho
  agent-autoloop backup [diretório]        Faz backup do banco de dados, da chave mestra, da configuração, das regras
                                    e do secrets.env; sem diretório, grava em ~/.agent-autoloop/backups
  agent-autoloop restore <diretório> [--yes]
                                    Com a central parada, restaura os dados desta máquina a partir de um backup
  agent-autoloop update                    Atualiza para a versão mais recente publicada
  agent-autoloop uninstall [--yes]         Desinstala o programa preservando os dados; --yes pula a confirmação
  agent-autoloop --version                 Versão e commit atual
  agent-autoloop help                      Esta ajuda
  agent-autoloop up                        Inicia (normalmente chamado pelo serviço do sistema)
  agent-autoloop service install|remove    Serviço do sistema

Configuração e dados ficam em ${HOME}. As regras ficam em ${RULES_FILE} e passam a valer sozinhas quando mudam.`;

const INIT_USAGE = `Uso: agent-autoloop init [--agent claude|codex] [--command 'um comando {prompt}'] [--port 3350] [--no-service]

  --agent      Conecta só este Agent: claude ou codex. Sem ele, conecta todos os que já estiverem instalados na máquina
  --command    Usa outro Agent de linha de comando; {prompt} entra como um argumento separado, com caminhos contendo
               espaços entre aspas; se o programa não existir nesta máquina, a instalação não é feita
  --port       Porta em que a central escuta; o padrão é 3350
  --no-service Não instala o serviço do sistema por enquanto; depois rode agent-autoloop up manualmente`;

const TRY_USAGE = `Uso: agent-autoloop try

Percorre o fluxo completo com o Agent conectado nesta máquina: ele pergunta, o processo encerra esperando a sua resposta,
você decide e ele continua até terminar.`;

const STATUS_USAGE = `Uso: agent-autoloop status [--json]

Como estão as coisas agora: quem está online, o que espera por você, o que está em andamento, o que já foi feito e quanto custou.
  --json  Imprime a estrutura bruta de /v1/state, para scripts e painéis`;

const RUNS_USAGE = `Uso: agent-autoloop runs [regra] [--before <nº da rodada>] [--json]

Lista as rodadas concluídas, das mais novas para as mais antigas, 20 por vez: número, hora de término, como foi, regra e resultado.
  regra     Mostra só as rodadas desta regra
  --before  Lista a partir desta rodada para trás, continuando de onde a listagem anterior parou
  --json    Imprime a estrutura bruta destas rodadas e o before da próxima página, para scripts`;

const UPDATE_USAGE = `Uso: agent-autoloop update

Atualiza para a versão mais recente publicada. Não aceita argumentos.`;

const UNINSTALL_USAGE = `Uso: agent-autoloop uninstall [--yes]

Desinstala o programa preservando regras, chaves e registros.
  --yes  Pula a confirmação`;

const RESTORE_USAGE = `Uso: agent-autoloop restore <diretório> [--yes]

A restauração substitui o banco de dados, a chave mestra, a configuração, as regras e o secrets.env desta máquina; pare a
central antes, e --yes pula a confirmação.`;

/** O que cada comando lê além das próprias palavras dele, e como usá-lo. */
const TAKES: Record<string, { flags: string[]; usage: string }> = {
  add: { flags: [], usage: "Uso: agent-autoloop add <url git>" },
  answer: { flags: ["text"], usage: "Uso: agent-autoloop answer <cartão> [número] [--text outra ideia]" },
  ask: {
    flags: ["task"],
    usage: `Uso: agent-autoloop ask --task <nome da tarefa agendada>, com a pergunta lida da entrada padrão:
  { "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0, "about": "para quem continua depois", "key": "nome fixo deste assunto" }
No rules.json esta tarefa agendada precisa ter cwd; quando você responde, a central acorda o Agent dela para continuar no cwd seguindo o skill e o prompt.`,
  },
  backup: { flags: [], usage: "Uso: agent-autoloop backup [diretório]" },
  check: { flags: [], usage: "Uso: agent-autoloop check [arquivo]" },
  conformance: {
    flags: ["config"],
    usage: "Uso: agent-autoloop conformance <endereço da central de teste> --config <arquivo de credenciais de teste>",
  },
  doctor: { flags: [], usage: "Uso: agent-autoloop doctor" },
  emit: {
    flags: ["dry-run", "subject", "summary", "detail", "link", "id", "key"],
    usage:
      "Uso: agent-autoloop emit <tipo> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key chave da fonte]",
  },
  init: { flags: ["agent", "command", "port", "no-service"], usage: INIT_USAGE },
  join: {
    flags: ["worker", "key", "no-service"],
    usage: "Uso: agent-autoloop join <endereço da central> --worker <nome> --key <chave> [--no-service]",
  },
  key: {
    flags: [],
    usage: `Uso: agent-autoloop key new <source|worker|channel|owner> <nome>
      agent-autoloop key list
      agent-autoloop key remove <tipo> <nome>`,
  },
  mcp: { flags: [], usage: "Uso: agent-autoloop mcp" },
  pause: {
    flags: ["reason", "until"],
    usage: "Uso: agent-autoloop pause <regra> [--reason motivo] [--until horário]",
  },
  // Só a primeira palavra é lida como tal: o resto é um resultado nas palavras de alguém, traços e tudo.
  resolve: { flags: [], usage: "Uso: agent-autoloop resolve <cartão> <resultado>" },
  restore: { flags: ["yes"], usage: RESTORE_USAGE },
  resume: { flags: [], usage: "Uso: agent-autoloop resume <regra>" },
  replay: {
    flags: ["since"],
    usage: "Uso: agent-autoloop replay <regra> --since <horário> (é este o comando impresso na retomada)",
  },
  rules: { flags: [], usage: "Uso: agent-autoloop rules explain [arquivo]" },
  runs: { flags: ["before", "json"], usage: RUNS_USAGE },
  run: {
    flags: ["subject", "reason"],
    usage: "Uso: agent-autoloop run <regra> [--subject objeto] [--reason descrição]",
  },
  service: { flags: [], usage: "Uso: agent-autoloop service install|remove" },
  status: { flags: ["json"], usage: STATUS_USAGE },
  stop: { flags: [], usage: "Uso: agent-autoloop stop <nº da rodada>" },
  tell: {
    flags: ["task"],
    usage: "Uso: agent-autoloop tell <número> [--task nome da tarefa agendada], com o texto lido da entrada padrão",
  },
  try: { flags: [], usage: TRY_USAGE },
  uninstall: { flags: ["yes"], usage: UNINSTALL_USAGE },
  up: { flags: [], usage: "Uso: agent-autoloop up" },
  update: { flags: [], usage: UPDATE_USAGE },
  why: { flags: ["json"], usage: "Uso: agent-autoloop why <nº da rodada> [--json]" },
};

type Flags = Record<string, string | true>;

function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

/**
 * Para numa flag que o comando não lê. Um --port com erro de digitação, sem isso, instalaria com o padrão em silêncio, e
 * --help instalaria de qualquer jeito.
 */
function refuseUnknownFlags(args: string[], { flags: known, usage }: { flags: string[]; usage: string }) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = Object.keys(flags(args).named).filter((name) => !known.includes(name));
  if (unknown.length) fail(`Parâmetro não reconhecido: ${unknown.map((name) => `--${name}`).join(", ")}\n\n${usage}`);
}

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) =>
  client(
    config.owner ??
      fail("Esta máquina não tem a chave do titular (um computador que só executa trabalho não consegue ver)"),
    config,
  );

/** As primeiras regras de uma instalação nova: os seus Agents e uma regra para experimentar o ciclo inteiro. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: "esta máquina" } },
    agents,
    channels: { desktop: { name: "notificação de desktop" } },
    rules: [
      {
        name: "experimente",
        when: { source: "local", types: ["try.*"] },
        to: first,
        cwd: path.join(HOME, "try"),
        prompt:
          "Esta é a execução de teste do agent-autoloop try: não altere nenhum arquivo nem faça outra coisa. Leia o arquivo de dados. " +
          'Se answers estiver vazio, faça uma pergunta: em title escreva "Execução de teste: escolha uma cor", ' +
          'em text escreva "Esta é uma execução de teste; qualquer opção serve.", ' +
          'em options escreva ["Azul","Verde"], em key escreva try-color e, na primeira linha da conclusão, "Fiz uma pergunta". ' +
          'Se answers não estiver vazio, escreva na primeira linha da conclusão "Você escolheu tal, execução de teste aprovada", ' +
          'trocando "tal" pelo chosen de answers (o texto da opção escolhida), e não anexe recibo.',
      },
    ],
    elsewhere: [],
  };
}

/** Mostra aos Agents do usuário como configurá-lo. Só para a instalação no lugar de sempre, nunca por cima da deles. */
function linkSkill() {
  if (process.env.AGENT_AUTOLOOP_HOME) return;
  for (const agent of [".claude", ".codex"]) {
    if (!existsSync(path.join(homedir(), agent))) continue;
    const link = path.join(homedir(), agent, "skills", "agent-autoloop");
    if (lstatSync(link, { throwIfNoEntry: false })) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(ROOT, "skills", "agent-autoloop"), link, process.platform === "win32" ? "junction" : "dir");
  }
}

/** O que digitar para executar este programa: o nome dele, se for isso que um shell encontra, senão onde ele está. */
function howToRun() {
  if (process.platform === "win32") {
    const found = findOnPath("agent-autoloop");
    if (found && realpathSync(found) === realpathSync(path.join(ROOT, "bin", "agent-autoloop.cmd")))
      return "agent-autoloop";
    return `& ${psQuote(process.execPath)} ${psQuote(PROGRAM)}`;
  }
  const found = spawnSync("/bin/sh", ["-c", "command -v agent-autoloop"], { encoding: "utf8" }).stdout.trim();
  if (found && realpathSync(found) === realpathSync(PROGRAM)) return "agent-autoloop";
  return /\s/.test(PROGRAM) ? `'${PROGRAM}'` : PROGRAM;
}

/**
 * Uma linha de comando dividida como um shell faria: espaços separam palavras, aspas mantêm uma junta e depois caem. Sem
 * escapes, porque um caminho do Windows é todo barras invertidas. Null quando uma aspa fica aberta.
 */
function commandWords(line: string) {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/** O que foi pedido na linha de comando, ou qualquer um dos Agents de sempre que esteja instalado. */
async function agentsToUse(named: Flags, worker: string) {
  const agents: Record<string, { name: string; worker: string; use: string; command?: string[] }> = {};
  const { adapterFor, findProgram } = await import("../worker/agents.ts");
  const command = text(named.command);
  if (command) {
    const words = commandWords(command);
    if (!words?.length) return fail(`Há aspas sem par em --command: ${command}`);
    // Encontrado agora, ou cada rodada de cada regra falha mais tarde com a instalação há muito dada como concluída.
    const [first] = words;
    const there = /[\\/]/.test(first)
      ? existsSync(path.resolve(first))
      : /^[\w.+@-]+$/.test(first) &&
        (() => {
          try {
            return Boolean(findProgram(first));
          } catch {
            return false;
          }
        })();
    if (!there)
      return fail(
        `Não foi possível encontrar ${first}: instale-o primeiro, ou escreva o caminho completo dele em --command.`,
      );
    agents.agent = { name: "Agent", worker, use: "command", command: words };
    return agents;
  }
  const wanted = text(named.agent);
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (wanted && wanted !== name) continue;
    const adapter = await adapterFor(name);
    try {
      // Um adaptador procura o próprio programa para montar a linha de comando e lança se ele não estiver lá.
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

async function init(args: string[]) {
  const { named, rest } = flags(args);
  // `init -p 4000`, sem isso, instalaria na porta padrão em silêncio.
  if (rest.length) return fail(`Parâmetro não reconhecido: ${rest.join(" ")}\n\n${INIT_USAGE}`);
  if (existsSync(CONFIG_FILE)) return fail(`Já está instalado: ${CONFIG_FILE}`);
  privateDirectory(HOME);
  mkdirSync(path.join(HOME, "try"), { recursive: true });
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = await agentsToUse(named, worker);
  if (!Object.keys(agents).length) {
    return fail(
      "Claude Code e Codex não foram encontrados nesta máquina. Instale e faça login primeiro, " +
        "ou use --command para indicar outro Agent de linha de comando, por exemplo --command 'hermes chat -Q -q {prompt}'",
    );
  }
  const port = text(named.port) ?? "3350";
  const url = `http://127.0.0.1:${port}`;
  const ownRules = !existsSync(RULES_FILE);
  if (ownRules) {
    writeFileSync(RULES_FILE, `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`);
  }
  const { addKey } = await import("../host/runtime.ts");
  const config: Config = {
    url,
    hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
    worker: { name: worker, key: addKey("worker", worker) },
    source: { name: "local", key: addKey("source", "local") },
    owner: addKey("owner", "owner"),
    // Um canal que só o rules.json conhece, ou só este arquivo, não faria nada: ele só liga se os dois forem nossos para escrever.
    ...(ownRules && { channels: { desktop: { key: addKey("channel", "desktop") } } }),
  };
  writeConfig(config);
  linkSkill();
  if (!named["no-service"]) {
    installService();
    await waitForHub();
  }
  const names = Object.values(agents).map((agent) => agent.name);
  const reach = ownRules ? "  Canal: notificação de desktop\n" : "";
  const run = howToRun();
  const next = named["no-service"]
    ? `Rode primeiro ${run} up para iniciar a central e depois, em outro terminal, ${run} try para percorrer o fluxo completo.`
    : `Rode ${run} try para percorrer o fluxo completo.`;
  console.log(`Instalação concluída.\n  Agents: ${names.join(", ")}\n${reach}  Regras: ${RULES_FILE}\n\n${next}`);
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker);
  const key = text(named.key);
  if (!url || !name || !key) return fail(TAKES.join.usage);
  // Entrar em outra central não pode substituir em silêncio as chaves de central, worker ou titular que esta máquina já tem.
  if (existsSync(CONFIG_FILE)) {
    return fail(
      `Já está configurado: ${CONFIG_FILE}. Para não sobrescrever as configurações existentes, faça antes um backup e edite a configuração manualmente.`,
    );
  }
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  const next = named["no-service"] ? `Rode ${howToRun()} up para começar.` : "";
  console.log(`Esta máquina passou a executar trabalho como ${name}. ${next}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card) {
  console.log(`\n[${card.kind === "ask" ? "Decisão sua" : "Para sua atenção"}] #${card.id} ${card.title}`);
  if (card.text) console.log(card.text);
  if (card.kind !== "ask") return;
  card.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}${index === card.recommend ? " (recomendado)" : ""}`);
  });
}

const howToAnswer = (card: Card) =>
  card.kind === "ask"
    ? `Responder: agent-autoloop answer ${card.id} <número>`
    : `Resolvido: agent-autoloop answer ${card.id}`;

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question("\nQual número? "));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(`Digite um número de 1 a ${card.options.length}.`);
  }
}

async function tryIt() {
  const config = readConfig();
  if (!config.source) return fail("Esta máquina não tem a chave de fonte.");
  const owner = ownerClient(config);
  const stamp = Date.now();
  // Uma central que não pode ser alcançada é dita logo abaixo, quando o evento não passa.
  const before = await owner.state().catch(() => ({ runs: [] }));
  const attempts = attemptsOf(before.runs);
  await client(config.source.key, config)
    .event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` })
    .catch((error) =>
      fail(
        `Não foi possível conectar à central (${error.message}): rode antes agent-autoloop up ou agent-autoloop service install`,
      ),
    );
  const retrying = waitingRetry(before.runs);
  if (retrying) {
    const clock = { timeZone: before.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Date(retrying.notBefore).toLocaleString("pt-BR", clock);
    console.log(
      `A tentativa anterior falhou (${retrying.error}); nova tentativa automática às ${time}, e os eventos desta vez serão tratados juntos.`,
    );
  } else console.log("Evento enviado; o Agent começou a trabalhar...");
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = newFailure(state.runs, attempts);
    if (failed) return fail(`O Agent falhou: ${failed.error}\nRode agent-autoloop doctor para verificar.`);
    if (asked === null) {
      // Um Agent que pergunta a mesma coisa de novo cai no cartão já aberto, então este pode ser de antes: é esse mesmo.
      const card: Card | undefined = state.cards.find(
        (open: Card) => open.kind === "ask" && open.title.startsWith("Execução de teste"),
      );
      if (!card) continue;
      asked = card.id;
      console.log(
        "\nO Agent encerrou esta rodada e fez uma pergunta a você. Agora ele não ocupa processo nem gasta Tokens.",
      );
      showCard(card);
      if (!process.stdin.isTTY) {
        console.log(
          `${howToAnswer(card)}\nDepois de responder, rode agent-autoloop status para vê-lo concluir o trabalho.`,
        );
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      console.log("Recebido; o Agent continua...");
      continue;
    }
    const done = state.recentCards.find(
      (card: { id: number; state: string }) => card.id === asked && card.state === "done",
    );
    if (done) {
      console.log(
        `Ele concluiu o trabalho: ${done.result}\n\nFuncionou. Agora adapte ${RULES_FILE} às suas próprias regras, ou diga uma palavra ao seu Agent.`,
      );
      return;
    }
  }
  fail("Nenhum resultado em cinco minutos. Rode agent-autoloop doctor para verificar.");
}

async function status(named: Flags) {
  const state = await ownerClient().state();
  if (named.json !== undefined) return console.log(JSON.stringify(state, null, 2));
  console.log(render(state, { color: colorFor(process.stdout, process.env), columns: process.stdout.columns }));
}

async function runs(args: string[]) {
  const { named, rest } = flags(args);
  if (rest.length > 1 || named.before === true) return fail(RUNS_USAGE);
  const before = named.before === undefined ? undefined : runOf(named.before, RUNS_USAGE);
  const owner = ownerClient();
  const { findRuns, runsText } = await import("./runs.ts");
  const found = await findRuns((at) => owner.state(at), { rule: rest[0], before });
  if (named.json !== undefined) return console.log(JSON.stringify({ runs: found.runs, before: found.more }, null, 2));
  const color = colorFor(process.stdout, process.env);
  console.log(runsText(found, { rule: rest[0], color, columns: process.stdout.columns }));
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail(TAKES.answer.usage);
  const words = text(named.text);
  const done = await ownerClient().answer(card, {
    ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }),
    ...(words && { text: words }),
  });
  console.log(
    !done.changed
      ? "Este cartão já foi tratado; nada mudou desta vez."
      : done.state === "closed"
        ? "Encerrado."
        : "Recebido; o Agent continua.",
  );
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail(TAKES.resolve.usage);
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? "Encerrado." : "Este cartão já foi tratado; nada mudou desta vez.");
}

async function pause(args: string[]) {
  const { named, rest } = flags(args);
  const body = {
    ...(text(named.reason) && { reason: text(named.reason) }),
    ...(text(named.until) && { until: text(named.until) }),
  };
  if (!rest[0]) return fail(TAKES.pause.usage);
  const done = await ownerClient().pause(rest[0], body);
  const { since, until, skipped } = done.paused;
  const ends = until ? `; retoma automaticamente ${localClock().when(until)}` : "";
  const lines = [done.changed ? `"${done.rule}" pausada${ends}.` : `"${done.rule}" já estava pausada${ends}.`];
  // Um agendamento deixa os seus momentos passarem e não guarda eventos.
  if (skipped === null)
    lines.push(
      "Durante a pausa os horários agendados não disparam e, ao retomar, os períodos perdidos não são reexecutados.",
    );
  else if (!until)
    lines.push(
      "Durante a pausa esta regra não recebe eventos nem os enfileira; ao retomar eles serão listados e poderão ser reexecutados.",
    );
  // Ninguém lê nada quando uma pausa termina sozinha, então o caminho para reexecutar é dito agora.
  else
    lines.push(
      "Durante a pausa esta regra não recebe eventos nem os enfileira; eles não serão listados na hora — reexecute depois:",
      `  ${replayCommand(done.rule, since)}`,
    );
  if (skipped?.count) lines.push(`Até agora ${skipped.count} eventos foram ignorados.`);
  console.log(lines.join("\n"));
}

/** Horários da central como se leem aqui, para o que responde a um comando em vez do estado. */
const localClock = () =>
  clockFor({ now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

async function resume(args: string[]) {
  const { rest } = flags(args);
  if (!rest[0]) return fail(TAKES.resume.usage);
  const done = await ownerClient().resume(rest[0]);
  if (!done.changed) return console.log(`"${done.rule}" não estava pausada.`);
  const { since, skipped } = done.paused ?? {};
  const { when } = localClock();
  const lines = [`"${done.rule}" retomada.`];
  if (skipped === null)
    lines[0] += " Os períodos perdidos não são reexecutados; a regra volta a disparar no próximo horário.";
  else if (skipped?.count === 0) lines[0] += " Nenhum evento foi ignorado durante a pausa.";
  else if (skipped) {
    lines[0] += ` Durante a pausa (desde ${when(since)}) ${skipped.count} eventos foram ignorados, sem reexecução:`;
    const room = Math.min(process.stdout.columns || 100, 120) - 2;
    for (const event of skipped.events) lines.push(`  ${skippedLine(event, room, when)}`);
    if (skipped.count > skipped.events.length) {
      lines.push(`  Total de ${skipped.count}; os ${skipped.events.length} mais recentes listados aqui`);
    }
    lines.push(`Reexecutar estes ${skipped.count}: ${replayCommand(done.rule, since)}`);
  }
  console.log(lines.join("\n"));
}

async function replay(args: string[]) {
  const { named, rest } = flags(args);
  const since = text(named.since);
  if (!rest[0] || !since) return fail(TAKES.replay.usage);
  const done = await ownerClient().replay(rest[0], { since });
  if (!done.events.length)
    return console.log("Nenhum evento para reexecutar: nada foi ignorado nesse período, ou tudo já foi reexecutado.");
  console.log(`${done.events.length} eventos reexecutados; rodadas ${done.runs.join(", ")} colocadas na fila.`);
}

async function runNow(args: string[]) {
  const { named, rest } = flags(args);
  if (!rest[0]) return fail(TAKES.run.usage);
  const body = {
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.reason) && { reason: text(named.reason) }),
  };
  const done = await ownerClient().run(rest[0], body);
  console.log(`Na fila: rodada ${done.run}.`);
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "●" : "○"} ${words}`);
    if (!ok) bad += 1;
  };
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, "ainda não está instalado: rode antes agent-autoloop init");
  const config = readConfig();
  if (config.hub) {
    try {
      const { channels } = checkRulesFile(RULES_FILE);
      say(true, `Regras ${RULES_FILE}`);
      for (const [id, channel] of Object.entries(channels)) {
        // Ninguém responde a partir de uma notificação de desktop, e um link só vai para quem ele foi enviado.
        if (id !== "desktop" && !channel.links && !channel.answerers) {
          console.log(`○ ${channel.name} sem answerers: qualquer pessoa neste canal pode responder aos cartões.`);
        }
      }
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  if (serviceRunning()) say(true, "Serviço do sistema em execução");
  else if (systemUnit()) say(true, "Serviço em nível de sistema em execução");
  else say(false, "O serviço do sistema não está em execução: agent-autoloop service install");
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, `Central ${config.url} (${String(health.commit).slice(0, 12)})`);
  } catch (error) {
    say(
      false,
      `Não foi possível conectar à central ${config.url}: ${(error as any).cause?.code ?? (error as Error).message}`,
    );
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        say(agent.online, `${agent.name} (${agent.worker}) ${agent.online ? "online" : "offline"}`);
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then(
            (adapter) => adapter.check?.(agent.program) ?? null,
            (error) => String(error.message),
          );
          say(!problem, problem ?? `${agent.name} pronto para uso`);
        }
      }
      for (const channel of state.channels)
        say(channel.online, `${channel.name} ${channel.online ? "online" : "offline"}`);
      const manual = path.join(ROOT, "skills", "agent-autoloop", "SKILL.md");
      if (!state.channels.length) {
        console.log(
          `○ Nenhum canal conectado: quando um Agent perguntar algo você não será avisado; rode agent-autoloop status para ver. Como conectar: ${manual}`,
        );
      } else if (state.channels.length === 1 && state.channels[0].id === "desktop") {
        console.log(
          "○ Só a notificação de desktop está conectada: quando um Agent perguntar algo, só esta máquina mostrará uma notificação; " +
            "se você não estiver na frente dela, ou se ela não tiver interface gráfica, não verá nada. " +
            `Para enviar ao Feishu/Lark, ao DingTalk e afins, veja como conectar em ${manual}`,
        );
      }
    } catch (error) {
      say(false, `Não foi possível ler o estado da central: ${(error as Error).message}`);
    }
  }
  if (bad) process.exit(1);
}

/** Só lê o arquivo: conferir um rascunho não pode abrir o banco de dados da central nem carregar o rascunho nele. */
function checkRulesFile(file: string) {
  let json: string;
  try {
    json = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `Não foi possível ler ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  return parseRules(json, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function check(args: string[]) {
  const file = path.resolve(args[0] ?? RULES_FILE);
  checkRulesFile(file);
  console.log(`Regras OK: ${file}`);
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if (action === "remove") {
    if (!kind || !name) return fail("Uso: agent-autoloop key remove <tipo> <nome>");
    const { changed } = await ownerClient().removeKey(kind, name);
    console.log(changed ? "Chave revogada." : "Essa chave não existe; talvez já tenha sido removida.");
    return;
  }
  const { addKey, listKeys } = await import("../host/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) {
    return fail("Uso: agent-autoloop key new <source|worker|channel|owner> <nome>");
  }
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail(TAKES.emit.usage);
  const event = {
    id: text(named.id) ?? randomUUID(),
    type,
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }),
    ...(text(named.link) && { link: text(named.link) }),
  };
  if (named["dry-run"] !== undefined) {
    // A central reconhece uma fonte pela chave dela, e aqui só se conhece a fonte da própria chave.
    if (text(named.key)) return fail("--dry-run simula com a fonte desta máquina e não pode ser usado junto com --key");
    if (!config.source) return fail("Esta máquina não tem chave de fonte: --dry-run precisa saber o nome da fonte");
    const { previewEvent } = await import("./explain.ts");
    console.log("Pré-visualização (com o rules.json desta máquina, sem conectar à central e sem gravar log):");
    for (const line of previewEvent(readFileSync(RULES_FILE, "utf8"), config.source.name, event)) console.log(line);
    return;
  }
  const secret = text(named.key) ?? config.source?.key ?? fail("Esta máquina não tem chave de fonte: use --key");
  const answer = await client(secret, config).event(event);
  const paused = answer.paused?.length ? `Não recebido por estar pausada: ${answer.paused.join(", ")}` : "";
  if (answer.routed.length) console.log(`Entregue a: ${answer.routed.join(", ")}${paused && `; ${paused}`}`);
  else console.log(paused ? `Registrado; ${paused}.` : "Registrado; nenhuma regra o recebeu.");
}

async function backupCommand(args: string[]) {
  const { rest } = flags(args);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.resolve(rest[0] ?? path.join(HOME, "backups", stamp));
  const { backup } = await import("./backup.ts");
  const { files } = await backup(HOME, target);
  console.log(
    `Backup concluído: ${target}\n  ${files.join(", ")}\nEle contém chaves: guarde-o em um lugar seguro. A restauração exige a central parada.`,
  );
}

async function restoreCommand(args: string[]) {
  const { named, rest } = flags(args);
  if (!rest[0]) return fail(RESTORE_USAGE);
  if (named.yes === undefined) {
    if (!process.stdin.isTTY)
      return fail(
        "A restauração substitui os dados desta máquina; após confirmar, rode agent-autoloop restore <diretório> --yes",
      );
    const answer = await askAtTerminal(
      "A restauração substitui o banco de dados, a chave mestra, a configuração, as regras e o secrets.env desta máquina. Continuar? [y/N] ",
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Nada foi restaurado.");
      return;
    }
  }
  const { restore } = await import("./backup.ts");
  const { safety } = await restore(HOME, path.resolve(rest[0]));
  console.log(
    `Restauração concluída. Os arquivos originais estão em ${safety}.\nIniciar: agent-autoloop up ou agent-autoloop service install`,
  );
}

async function rulesCommand(args: string[]) {
  const { rest } = flags(args);
  if (rest[0] !== "explain" || rest.length > 2) return fail(TAKES.rules.usage);
  const file = rest[1] ? path.resolve(rest[1]) : RULES_FILE;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return fail(`Não foi possível ler ${file}: ${(error as Error).message}`);
  }
  const { explainRules } = await import("./explain.ts");
  for (const line of explainRules(text, Date.now())) console.log(line);
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail(TAKES.tell.usage);
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail("O texto a comunicar vem da entrada padrão e não pode estar vazio.");
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret) return fail(task ? "Esta máquina não é um worker" : "Esta máquina não tem chave de fonte");
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? "Este assunto já foi comunicado; nada foi enviado desta vez." : "Comunicado.");
}

async function ask(args: string[]) {
  const { named, rest } = flags(args);
  const task = text(named.task);
  if (!task || rest.length) return fail(TAKES.ask.usage);
  let question: unknown;
  try {
    question = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return fail("A pergunta vem da entrada padrão como um JSON: igual ao ask de um recibo");
  }
  const config = readConfig();
  if (!config.worker) return fail("Esta máquina não é um worker");
  const answer = await client(config.worker.key, config).tell({ task, ask: question });
  console.log(
    answer.duplicate ? "O mesmo assunto ainda aguarda a sua resposta; nada foi perguntado desta vez." : "Perguntado.",
  );
}

/** Uma rodada é nomeada pelo número dela; qualquer outra coisa chegaria à central como /v1/runs/NaN e voltaria como "não existe esse endereço". */
function runOf(word: string | undefined, usage: string) {
  const id = Number(word);
  if (word === undefined || !/^[1-9][0-9]*$/.test(word) || !Number.isSafeInteger(id)) return fail(usage);
  return id;
}

async function why(args: string[]) {
  const id = runOf(
    args.find((arg) => !arg.startsWith("--")),
    "Uso: agent-autoloop why <nº da rodada> [--json]",
  );
  const facts = await ownerClient().why(id);
  if (args.includes("--json")) return console.log(JSON.stringify(facts, null, 2));
  const { formatWhy } = await import("./why.ts");
  console.log(formatWhy(id, facts));
}

async function checkConformance(args: string[]) {
  const { named, rest } = flags(args);
  const file = text(named.config) ?? process.env.AGENT_AUTOLOOP_CONFORMANCE;
  if (!rest[0] || !file) return fail(TAKES.conformance.usage);
  const { conformance } = await import("../protocol/conformance.ts");
  console.log(JSON.stringify(await conformance(rest[0], JSON.parse(readFileSync(file, "utf8"))), null, 2));
}

async function stop(args: string[]) {
  const id = runOf(args[0], "Uso: agent-autoloop stop <nº da rodada>");
  await ownerClient().cancel(id);
  console.log("A parada foi notificada.");
}

/** Um comando rodado logo após iniciar o serviço ainda não encontraria central: espera-se a desta máquina, se ela tiver uma. */
async function waitForHub() {
  const config = readConfig();
  if (!config.hub) return;
  const answering = await untilAnswering(config.url);
  if (answering === false) {
    const log = serviceLogs();
    const last = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").slice(-5).join("\n") : "";
    console.error(
      `O serviço do sistema iniciou, mas a central não respondeu em 20 segundos. Veja o log: ${log}${last ? `\n\n${last}` : ""}`,
    );
  }
  // Uma tarefa de login pede o token limitado do usuário, e o Administrator nativo recebe o completo do mesmo jeito.
  const hub = answering && process.platform === "win32" ? runningUp() : null;
  if (hub !== null && aboveDesktop(hub)) {
    removeService();
    fail(
      "A central iniciada pela tarefa de login recebeu privilégios administrativos completos acima do seu desktop, e cada Agent " +
        "despachado por ela também os teria, então essa tarefa não foi instalada " +
        `(a conta Administrator nativa do Windows se comporta assim). ${startupInstead()}`,
    );
  }
}

/** fetch diz apenas "fetch failed" quando nenhuma central responde; qual central, por quê e o que fazer é o que uma pessoa pode usar. */
function plainly(error: any): string {
  if (!(error instanceof TypeError && error.message === "fetch failed")) return error?.message ?? String(error);
  let url = "";
  try {
    url = readConfig().url;
  } catch {}
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message;
  return (
    `Não foi possível conectar à central ${url}${why ? ` (${why})` : ""}: a central não está em execução, ou acabou de iniciar e ainda não está pronta. ` +
    "Rode agent-autoloop service install na máquina da central para iniciá-la; se acabou de instalar ou de atualizar, espere alguns segundos e tente de novo."
  );
}

async function service(args: string[]) {
  if (args[0] === "install") {
    // Instalar por cima de dados preservados chega aqui e não no init, e a desinstalação levou os links embora.
    linkSkill();
    installService();
    return waitForHub();
  }
  if (args[0] === "remove") return removeService();
  fail(TAKES.service.usage);
}

/** Um plugin é uma pasta própria dentro desta instalação, com o nome do repositório dele. */
function addPlugin(args: string[]) {
  const url = args[0] ?? fail(TAKES.add.usage);
  const name = url
    .replace(/\/$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    fail(
      `O nome de plugin "${name}" não pode ser usado: só pode usar letras minúsculas, números e -. As regras escrevem esse mesmo nome em use`,
    );
  mkdirSync(path.join(HOME, "plugins"), { recursive: true });
  const clone = spawnSync("git", ["clone", "--", url, path.join(HOME, "plugins", name)], { stdio: "inherit" });
  if (clone.status !== 0) fail("A instalação falhou.");
  console.log(`${name} instalado.`);
}

async function update() {
  const { updateCode } = await import("./update.ts");
  const { changed, to } = updateCode(ROOT);
  const version = to ? ` (${to})` : "";
  if (!changed) return console.log(`Já está na versão mais recente${version}.`);
  const told = restartService();
  if (told === undefined) await waitForHub();
  console.log(`Atualização concluída${version}. ${told ?? ""}`);
}

async function askAtTerminal(question: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () => (await import("./mcp.ts")).mcp(),
  add: () => addPlugin(args),
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../host/up.ts")).up(),
  try: () => tryIt(),
  status: () => status(flags(args).named),
  why: () => why(args),
  runs: () => runs(args),
  conformance: () => checkConformance(args),
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check: () => check(args),
  rules: () => rulesCommand(args),
  pause: () => pause(args),
  resume: () => resume(args),
  replay: () => replay(args),
  run: () => runNow(args),
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  ask: () => ask(args),
  stop: () => stop(args),
  backup: () => backupCommand(args),
  restore: () => restoreCommand(args),
  update,
  uninstall: async () => {
    const { uninstall } = await import("./uninstall.ts");
    await uninstall(flags(args).named.yes !== undefined, process.stdin.isTTY ? askAtTerminal : null);
  },
  service: () => service(args),
  help: () => console.log(HELP),
  "--help": () => console.log(HELP),
  "-h": () => console.log(HELP),
  "--version": () => console.log(versionLine()),
};
if (!command || !commands[command]) {
  console.log(HELP);
  if (command) process.exit(1);
} else {
  if (TAKES[command]) refuseUnknownFlags(command === "resolve" ? args.slice(0, 1) : args, TAKES[command]);
  Promise.resolve()
    .then(commands[command])
    .catch((error) => fail(plainly(error)));
}
