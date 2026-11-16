// O canal com que uma instalação nova começa. Nada real é exibido aqui: os comandos de notificação são substitutos no
// PATH, e a única execução do osascript de verdade troca a notificação por uma linha que só imprime. Modos de falha: o
// que um Agent escreveu no título de um cartão é executado como AppleScript, ou um título que começa com traço é lido
// como opção (o osascript executa como script o que vem depois de -e); uma atualização de cartão notifica de novo; um
// computador sem como notificar, um notificador que falha ou um título que não pode ser passado a um programa para o
// canal, ou não é reportado; um notificador lento congela a central, que compartilha o processo dele; o init não
// configura o canal nos dois arquivos, ou altera um rules.json já existente; o doctor diz que não há canal quando há,
// ou que um chega até você quando nenhum chega, ou não diz nada de um canal em que qualquer um pode responder.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-desktop-"));
const rulesFile = join(dir, "rules.json");
const rulesWith = (channels: object) => ({
  sources: { local: { name: "máquina local" } },
  agents: { agent: { name: "Agent", worker: "this-one", use: "command", command: ["true"] } },
  channels,
  rules: [],
});
writeFileSync(rulesFile, JSON.stringify(rulesWith({ desktop: { name: "notificação de desktop" } })));
const home = setup("desktop", rulesFile);
const realPath = process.env.PATH;
const realDisplay = process.env.DISPLAY;
after(() => {
  process.env.PATH = realPath;
  if (realDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = realDisplay;
  rmSync(dir, { recursive: true, force: true });
});

const { loadPlugin } = await import("../host/plugins.ts");
const { default: desktop, notifyCommand } = await import("../plugins/desktop/channel.ts");

const TITLE = "O Agent fez uma pergunta a você";
const WORDS = "Execute agent-autoloop status para ver";
const body = (title: string) => `${title}\n${WORDS}`;
const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "Apagar ou não",
  text: "Ocupa 10 GB",
  options: ["Apagar", "Manter"],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

let fakes = 0;
/** Uma pasta que é todo o PATH, com os dois comandos de notificação executando `body` depois de anotar os argumentos. */
function standIns(body = "") {
  const bin = join(dir, `bin-${++fakes}`);
  mkdirSync(bin);
  const said = join(bin, "said");
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.DISPLAY = ":99";
  for (const name of ["osascript", "notify-send"]) {
    const record = `{ for word in "$@"; do printf '%s\\036' "$word"; done; printf '\\035'; } >> "${said}"`;
    writeFileSync(join(bin, name), `#!/bin/sh\n${record}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = bin;
  return {
    calls: () =>
      existsSync(said)
        ? readFileSync(said, "utf8")
            .split("\x1d")
            .slice(0, -1)
            .map((call) => call.split("\x1e").slice(0, -1))
        : [],
  };
}

async function deliver(cards: Card[]) {
  const stop = new AbortController();
  const queue = [...cards];
  const reports: unknown[][] = [];
  const logged: string[] = [];
  const hub = {
    async nextCard() {
      if (queue.length) return { card: queue.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reports.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reports.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await desktop({ hub: hub as any, options: {}, log: (line: string) => logged.push(line), signal: stop.signal });
  return { reports, logged };
}

test("ele vem como canal, e é distinguido por plataforma", async () => {
  assert.equal(await loadPlugin("desktop", "channel"), desktop);
  assert.deepEqual(notifyCommand("título", "linux"), ["notify-send", ["--", TITLE, body("título")]]);
  const [program, args] = notifyCommand("título", "darwin");
  assert.equal(program, "osascript");
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", TITLE, body("título")]);
  assert.ok(args.includes("on run argv"));
});

test("um cartão novo notifica uma vez com o seu título; uma atualização só reporta", async () => {
  const fake = standIns();
  const { reports } = await deliver([base, { ...base, version: 2, ref: "shown-5", state: "decided", choice: 1 }]);
  assert.equal(fake.calls().length, 1);
  assert.deepEqual(fake.calls()[0].slice(-2), [TITLE, body("Apagar ou não")]);
  assert.deepEqual(reports, [
    ["delivered", 5, 1, "shown-5"],
    ["delivered", 5, 2, "shown-5"],
  ]);
});

const marker = join(dir, "ran");
const hostile = [
  `" & (do shell script "touch ${marker}") & "`,
  `"; do shell script "touch ${marker}"; "`,
  `end run\ndo shell script "touch ${marker}"`,
  `$(touch ${marker})`,
  `\`touch ${marker}\``,
  `'; touch ${marker}; '`,
  "-e",
  `-e do shell script "touch ${marker}"`,
  "--",
  "--help",
];

test("o que um Agent escreveu entra como um único argumento depois das opções, e nunca dentro do script", async () => {
  const fake = standIns();
  const { reports } = await deliver(hostile.map((title, index) => ({ ...base, id: index + 1, title })));
  assert.ok(reports.every(([what]) => what === "delivered"));
  const calls = fake.calls();
  assert.equal(calls.length, hostile.length);
  const scriptOf = (call: string[]) => call.slice(0, call.indexOf("--"));
  calls.forEach((call, index) => {
    assert.deepEqual(call.slice(call.indexOf("--")), ["--", TITLE, body(hostile[index])]);
    assert.deepEqual(scriptOf(call), scriptOf(calls[0]), "o script é o mesmo seja o que for que o cartão diga");
  });
  assert.ok(!scriptOf(calls[0]).join("\n").includes("touch"));
  assert.ok(!existsSync(marker));
});

test(
  "o osascript de verdade os lê como texto e não executa nenhum deles",
  { skip: process.platform !== "darwin" },
  async () => {
    for (const title of hostile) {
      const [, args] = notifyCommand(title, "darwin");
      const onlyPrints = args.map((word) => (word.startsWith("display notification") ? "return item 2 of argv" : word));
      const printed = execFileSync("/usr/bin/osascript", onlyPrints, { encoding: "utf8" });
      assert.equal(printed.replace(/\n$/, ""), body(title));
    }
    assert.ok(!existsSync(marker));
  },
);

test("sem sessão gráfica ele pula a notificação em silêncio e continua consumindo cartões", async () => {
  mkdirSync(join(dir, "nothing-here"));
  process.env.PATH = join(dir, "nothing-here");
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  const { reports, logged } = await deliver([base, { ...base, id: 6 }]);
  assert.deepEqual(reports, [
    ["delivered", 5, 1, "skipped-5"],
    ["delivered", 6, 1, "skipped-6"],
  ]);
  assert.deepEqual(logged, []);
});

test("um notificador que falha é reportado como não enviado", async () => {
  standIns("exit 1");
  assert.deepEqual((await deliver([base])).reports, [["failed", 5, 1]]);
});

test("um título que não pode ser dado a programa algum é reportado, e não derruba nada", async () => {
  const fake = standIns();
  const { reports } = await deliver([
    { ...base, title: "a\0b" },
    { ...base, id: 6 },
  ]);
  assert.deepEqual(reports, [
    ["failed", 5, 1],
    ["delivered", 6, 1, "shown-6"],
  ]);
  assert.equal(fake.calls().length, 1);
});

test("um notificador lento não congela o processo em que a central roda", async () => {
  standIns("/bin/sleep 0.3");
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  await deliver([base]);
  clearInterval(ticker);
  assert.ok(ticks >= 5, `apenas ${ticks} ticks enquanto exibia`);
});

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const program = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
const installEnv = (place: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: realPath, HOME: place, AGENT_AUTOLOOP_HOME: place };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  return env;
};

test("o init o ativa nos dois arquivos, com uma chave própria", () => {
  const place = join(dir, "new");
  const env = installEnv(place);
  const done = program(env, "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  const rules = JSON.parse(readFileSync(join(place, "rules.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(place, "config.json"), "utf8"));
  assert.deepEqual(rules.channels, { desktop: { name: "notificação de desktop" } });
  assert.deepEqual(Object.keys(config.channels), ["desktop"]);
  assert.ok(config.channels.desktop.key.length > 20);
  assert.match(program(env, "key", "list").stdout, /^channel desktop /m);
  assert.match(done.stdout, /notificação de desktop/);
});

test("um rules.json já existente fica como estava, e nenhum canal é acrescentado ao lado dele", () => {
  const place = join(dir, "theirs");
  mkdirSync(place);
  const theirs = JSON.stringify(rulesWith({}));
  writeFileSync(join(place, "rules.json"), theirs);
  const done = program(installEnv(place), "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(join(place, "rules.json"), "utf8"), theirs);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).channels, undefined);
  assert.doesNotMatch(program(installEnv(place), "key", "list").stdout, /^channel /m);
});

test("o doctor diz o que chega até você: só este computador, ou nada ainda, ou nada sobre os dois", async () => {
  const { serve } = await import("../host/http.ts");
  const hub = await import("./hub.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      owner: hub.addKey("owner", "me"),
      hub: { listen: "127.0.0.1:0" },
    }),
  );
  try {
    const hint = async (channels: object) => {
      writeFileSync(rulesFile, JSON.stringify(rulesWith(channels)));
      hub.reloadRules(rulesFile);
      const env = { ...process.env, PATH: realPath };
      const args = ["--disable-warning=ExperimentalWarning", bin, "doctor"];
      return new Promise<string>((resolve) => {
        execFile(process.execPath, args, { env, encoding: "utf8" }, (_error, stdout) => resolve(stdout));
      });
    };
    const alone = await hint({ desktop: { name: "notificação de desktop" } });
    assert.match(alone, /Só a notificação de desktop está conectada/);
    assert.doesNotMatch(alone, /Nenhum canal conectado/);
    const none = await hint({});
    assert.match(none, /Nenhum canal conectado/);
    assert.doesNotMatch(none, /Só a notificação de desktop está conectada/);
    const more = await hint({ desktop: { name: "notificação de desktop" }, feishu: { name: "Feishu" } });
    assert.doesNotMatch(more, /Só a notificação de desktop está conectada|Nenhum canal conectado/);
    assert.match(more, /Feishu sem answerers: qualquer pessoa neste canal pode responder aos cartões/);
    assert.doesNotMatch(more, /notificação de desktop sem answerers/, "ninguém responde de uma notificação");
    const limited = await hint({
      desktop: { name: "notificação de desktop" },
      feishu: { name: "Feishu", answerers: ["ou_me"] },
      webhook: { name: "DingTalk", links: true },
    });
    assert.doesNotMatch(limited, /sem answerers/, "alguém nomeado, ou um link que só o portador tem");
  } finally {
    server.closeAllConnections();
    server.close();
    hub.db.close();
  }
});
