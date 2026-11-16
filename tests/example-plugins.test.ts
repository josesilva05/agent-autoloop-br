// Modos de falha: um exemplo importa algo que só existe neste repositório, então carrega aqui e quebra depois que o
// `agent-autoloop add` o coloca em outro lugar; o add deixa o ponto de entrada onde o carregador não procura; o `read` do
// hello-agent lança um erro numa saída que ele não espera (um erro lançado interrompe o worker) ou perde a sessão, ou nunca
// diz que uma rodada em que ele continuou começou, de modo que uma rodada retomada que quebrou é executada de novo do zero
// numa sessão nova e faz o trabalho duas vezes; o hello-channel escreve um cartão mas nunca o reporta, então a central o
// envia de novo a cada minuto; o hello-source aceita uma assinatura errada ou ausente, ou entrega um evento que a central
// recusa; um exemplo se desvia dos tipos do motor; um comando do tutorial não roda como está escrito; o add recebe um
// repositório cujo nome não pode ser nome de plugin sem dizer que nome ele calculou e recusou.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import helloAgent from "../examples/plugins/hello-agent/agent.ts";
import helloChannel from "../examples/plugins/hello-channel/channel.ts";
import helloSource from "../examples/plugins/hello-source/source.ts";
import type { ChannelContext } from "../host/channels.ts";
import type { Adapter } from "../worker/agents.ts";

// Os exemplos trazem os próprios tipos para se sustentarem sozinhos num repositório; estes os mantêm em passo com os do motor.
const adapter: Adapter = helloAgent;
const channel: (context: ChannelContext) => Promise<void> = helloChannel;
assert.ok(adapter && channel);

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "agent-autoloop.ts");
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-example-plugins-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_") && name !== "NODE_TEST_CONTEXT"),
  ) as NodeJS.ProcessEnv;
const agentAutoloop = (args: string[], home: string) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    env: { ...cleanEnv(), AGENT_AUTOLOOP_HOME: home },
    encoding: "utf8",
  });
const newKey = (home: string, kind: string, name: string) =>
  agentAutoloop(["key", "new", kind, name], home).stdout.trim().split("\n").at(-1)!;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until<T>(what: string, look: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = await look();
    if (seen) return seen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Não aconteceu a tempo: ${what}`);
}

const turn = {
  prompt: "Faça isso",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};

test("hello-agent: inicia uma sessão ou continua numa, e lê qualquer saída sem lançar erro", () => {
  const said = (argv: string[]) => JSON.parse(argv.at(-1)!);
  assert.equal(said(helloAgent.command(turn)).session, "new-id");
  assert.equal(said(helloAgent.command({ ...turn, resume: "old-id" })).session, "old-id");
  assert.match(said(helloAgent.command(turn)).text, /Recebi um prompt de 9 caracteres, permissão edit/);
  assert.deepEqual(helloAgent.read('{"partial', null, ""), {}, "ainda em execução");
  assert.deepEqual(helloAgent.read('{"session":"s","text":"pronto"}\n', 0, ""), { session: "s", text: "pronto" });
  assert.ok(helloAgent.read("not json", 0, "").error);
  assert.equal(helloAgent.read("", 2, "boom").error, "boom");
  assert.ok(helloAgent.read("", 2, "").error);
});

test("hello-agent: uma rodada que recebeu o prompt diz isso, para que uma retomada que quebrou não rode do zero", () => {
  const argv = helloAgent.command({ ...turn, resume: "old-id" });
  const printed = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }).stdout;
  const took = printed.split("\n").find((line) => line.trim())!;
  // O que o worker lê enquanto ainda está em curso, ou depois de o processo ter sido morto: a sessão em que continuou, e
  // que ele tem o prompt. Lida como nunca iniciada, uma nova tentativa abre outra sessão e o trabalho é feito duas vezes.
  assert.deepEqual(helloAgent.read(took, null, ""), { session: "old-id", started: true }, "ainda em curso");
  assert.equal(helloAgent.read(took, 137, "").started, true, "morto depois de ter começado");
  assert.equal(helloAgent.read(took, 137, "").session, "old-id", "para que a nova tentativa continue na mesma sessão");
  // A resposta dele é a última linha, e ter recebido o prompt continua fazendo parte do que ele diz.
  assert.deepEqual(helloAgent.read(printed, 0, ""), {
    session: "old-id",
    started: true,
    text: "Recebi um prompt de 9 caracteres, permissão edit. Este é o hello-agent e ele não fez nada.",
  });
});

test("hello-channel: escreve um cartão novo, o reporta e deixa em paz um cartão que já escreveu", async () => {
  const file = join(scratch, "unit-cards.txt");
  const stop = new AbortController();
  const card = { id: 5, version: 1, ref: null, kind: "ask", state: "open", title: "Excluir o arquivo" };
  const queue = [
    {
      ...card,
      text: "Ocupou 10 GB",
      options: ["excluir", "manter"],
      recommend: 1,
      choice: null,
      answer: null,
      result: null,
    },
    {
      ...card,
      version: 2,
      ref: "already",
      text: "",
      options: [],
      recommend: null,
      choice: 0,
      answer: null,
      result: null,
    },
  ];
  const reported: unknown[][] = [];
  const hub = {
    nextCard: async () => {
      const next = queue.shift();
      if (!next) stop.abort();
      return { card: next ? { ...next, link: null } : null };
    },
    delivered: async (...args: unknown[]) => reported.push(args),
    failed: async (...args: unknown[]) => assert.fail(`failed: ${args}`),
    answer: async () => assert.fail("um arquivo não pode responder"),
  };
  await helloChannel({ hub, options: { file }, log: () => {}, signal: stop.signal } as unknown as ChannelContext);
  const written = readFileSync(file, "utf8");
  assert.match(written, /Excluir o arquivo/);
  assert.match(written, /1\. excluir/);
  assert.equal(written.match(/Excluir o arquivo/g)?.length, 1, "uma atualização não é escrita de novo");
  assert.deepEqual(reported, [
    [5, 1, "file-5"],
    [5, 2, "already"],
  ]);
});

test("hello-channel: avisa quando não consegue escrever", async () => {
  const stop = new AbortController();
  const failures: unknown[][] = [];
  const hub = {
    nextCard: async () => {
      if (failures.length) stop.abort();
      return { card: failures.length ? null : { id: 6, version: 1, ref: null, title: "t", text: "", options: [] } };
    },
    delivered: async () => assert.fail("não foi escrito"),
    failed: async (...args: unknown[]) => failures.push(args),
    answer: async () => {},
  };
  const options = { file: join(scratch, "no", "such", "folder", "cards.txt") };
  await helloChannel({ hub, options, log: () => {}, signal: stop.signal } as unknown as ChannelContext);
  assert.equal(failures[0][0], 6);
});

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("hello-source: só passa o que estiver assinado com o segredo", () => {
  const body = JSON.stringify({ id: "evt-1", kind: "paid", order: 42, note: "o pedido foi pago" });
  const given = (signature: unknown, secret = "s3cret") => ({
    headers: { "x-shop-signature": signature as string },
    body,
    secret,
  });
  assert.deepEqual(helloSource(given(sign("s3cret", body))), [
    { id: "evt-1", type: "order.paid", subject: "order-42", summary: "o pedido foi pago" },
  ]);
  assert.throws(() => helloSource(given(sign("wrong", body))), "assinado com o segredo errado");
  assert.throws(() => helloSource(given(undefined)), "sem assinatura");
  assert.throws(() => helloSource(given("sha256=short")), "uma assinatura de outro comprimento");
  assert.throws(() => helloSource(given(sign("", body), "")), "sem segredo configurado, nada é aceito");
  const ping = JSON.stringify({ id: "evt-2", kind: "ping" });
  assert.deepEqual(
    helloSource({ headers: { "x-shop-signature": sign("s3cret", ping) }, body: ping, secret: "s3cret" }),
    [],
  );
});

/** Um repositório próprio, do jeito que alguém publica um plugin: o arquivo de entrada na raiz. */
function repository(name: string, file: string, folder = name) {
  const dir = join(scratch, "repos", folder);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "examples", "plugins", name, file), join(dir, file));
  const git = (...args: string[]) => {
    const done = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "first");
  return dir;
}

test("a pasta em que um repositório é instalado é o nome do plugin, em minúsculas, e um nome que nenhum plugin pode ter é recusado por ele", () => {
  const refusedHome = mkdtempSync(join(scratch, "home-"));
  const refused = agentAutoloop(["add", repository("hello-agent", "agent.ts", "hello_agent")], refusedHome);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /hello_agent/, "ele diz qual nome de plugin calculou e recusou");
  assert.ok(!existsSync(join(refusedHome, "plugins", "hello_agent")), "nada cai onde o carregador não consegue usar");

  const casedHome = mkdtempSync(join(scratch, "home-"));
  const added = agentAutoloop(["add", repository("hello-agent", "agent.ts", "Hello-Plugin")], casedHome);
  assert.equal(added.status, 0, added.stderr);
  assert.ok(
    existsSync(join(casedHome, "plugins", "hello-plugin", "agent.ts")),
    "a pasta é o nome do repositório em minúsculas, que é o que regras e configuração declaram em `use`",
  );
});

test("agent-autoloop add a partir de um repositório git, e então os três rodam numa central real", async () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const plugins = [
    ["hello-agent", "agent.ts"],
    ["hello-channel", "channel.ts"],
    ["hello-source", "source.ts"],
  ];
  for (const [name, file] of plugins) {
    const added = agentAutoloop(["add", repository(name, file)], home);
    assert.equal(added.status, 0, added.stderr);
    assert.ok(existsSync(join(home, "plugins", name, file)), `${name} não foi instalado onde o carregador procura`);
  }
  const work = mkdtempSync(join(scratch, "work-"));
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify({
      sources: { shop: { name: "shop", adapter: "hello-source" } },
      agents: { hello: { name: "Hello", worker: "mac-mini", use: "hello-agent", access: "read" } },
      channels: { cards: { name: "Arquivo" } },
      rules: [
        {
          name: "Pedido",
          when: { source: "shop", types: ["order.*"] },
          to: "hello",
          cwd: work,
          prompt: "Processe este pedido.",
          tell: "always",
        },
      ],
    }),
  );
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const cards = join(scratch, "cards.txt");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url,
      hub: { listen: `127.0.0.1:${port}` },
      worker: { name: "mac-mini", key: newKey(home, "worker", "mac-mini") },
      channels: { cards: { use: "hello-channel", key: newKey(home, "channel", "cards"), file: cards } },
    }),
  );
  const owner = { authorization: `Bearer ${newKey(home, "owner", "me")}` };
  writeFileSync(join(home, "secrets.env"), "AGENT_AUTOLOOP_SECRET_SHOP=s3cret\n");
  const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "up"], {
    env: { ...cleanEnv(), AGENT_AUTOLOOP_HOME: home, SHELL: "/bin/sh" },
    stdio: "ignore",
  });
  const stream = new AbortController();
  try {
    await until("a central subir", () =>
      fetch(`${url}/healthz`)
        .then((up) => up.ok)
        .catch(() => false),
    );
    const body = JSON.stringify({ id: "evt-1", kind: "paid", order: 42, note: "o pedido foi pago" });
    const post = (signature: string) =>
      fetch(`${url}/v1/in/shop`, { method: "POST", headers: { "x-shop-signature": signature }, body });
    assert.equal((await post(sign("wrong", body))).status, 401);
    const accepted = await post(sign("s3cret", body));
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).events[0].routed, ["Pedido"]);
    const run = await until("esta rodada terminar", async () => {
      const state = await (await fetch(`${url}/v1/state`, { headers: owner })).json();
      return state.runs.find((run: { state: string }) => run.state === "done");
    });
    assert.match(
      run.summary,
      /Recebi um prompt de \d+ caracteres, permissão read/,
      "o access da regra chega ao plugin",
    );
    assert.ok(run.session, "a sessão que ele imprimiu é mantida");
    await until(
      "o cartão ser escrito no arquivo",
      () => existsSync(cards) && readFileSync(cards, "utf8").includes(run.summary),
    );
    const log = await fetch(`${url}/v1/stream?after=0`, { headers: owner, signal: stream.signal });
    const reader = log.body!.getReader();
    const decoder = new TextDecoder();
    let facts = "";
    await until("a entrega ser registrada", async () => {
      facts += decoder.decode((await reader.read()).value, { stream: true });
      return /"type":"delivered"/.test(facts);
    });
  } finally {
    stream.abort();
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
  }
});

/** Um bloco do tutorial, executado do jeito que um leitor o colaria: neste checkout, numa porta livre, com o CLI real. */
async function runBlock(heading: string, oldPort: number) {
  const tutorial = readFileSync(join(ROOT, "docs", "plugins.md"), "utf8");
  const block = new RegExp(`## ${heading}[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\`\`\``).exec(tutorial)?.[1];
  assert.ok(block, `em docs/plugins.md precisa haver um bloco de comandos abaixo de "${heading}"`);
  const dir = mkdtempSync(join(scratch, "block-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const shim = join(bin, "agent-autoloop");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  const port = await freePort();
  const script = block.replaceAll("~/.agent-autoloop/app", ROOT).replaceAll(String(oldPort), String(port));
  const child = spawn("sh", ["-c", script], {
    cwd: ROOT,
    detached: true,
    env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh", TMPDIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  // O bloco inicia uma central própria em segundo plano: se ele não chegar a pará-la, o grupo inteiro vai junto.
  const limit = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 60_000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(limit);
  return { code, out };
}

test("o primeiro bloco do tutorial roda os três exemplos como está escrito", async () => {
  const { code, out } = await runBlock("Comece executando", 3399);
  assert.equal(code, 0, out);
  assert.match(out, /agent-autoloop add a partir de um repositório git/);
});

test("o bloco de conformidade do tutorial passa como está escrito", async () => {
  const { code, out } = await runBlock("Teste de conformidade", 3398);
  assert.equal(code, 0, out);
  assert.match(out, /pass [1-9]/);
});
