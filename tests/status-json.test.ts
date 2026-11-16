// Modos de falha: --json muda o estado em vez de imprimi-lo; a saída para pessoas deixa de ser a simples; uma flag desconhecida
// é ignorada e o comando faz outra coisa em silêncio; um cliente não consegue dizer de onde no registro o estado foi lido, então
// reproduz o registro inteiro ou perde o que veio no meio; um cartão do titular não pode ser ligado ao assunto a que se refere.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("status-json");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
  if (hub.db.isOpen) hub.db.close();
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, owner: hub.addKey("owner", "reader") }),
);
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("o estado expõe só as reverificações pendentes na primeira página", () => {
  hub.ingest("app", { id: "timer-state", type: "feedback.new", subject: "#timer" }, at(0));
  const job = hub.claimNext("w1", "timer-state", at(0))!;
  hub.finish(
    job.run,
    job.token,
    {
      outcome: "done",
      later: [{ key: "verify", at: new Date(at(100)).toISOString(), about: "verificar o resultado" }],
    },
    at(1),
  );
  assert.deepEqual(hub.stateOf(at(2)).timers, [
    {
      rule: "opiniões",
      lane: "#timer",
      key: "verify",
      about: "verificar o resultado",
      at: new Date(at(100)).toISOString(),
    },
  ]);
  assert.deepEqual(hub.stateOf(at(2), job.run + 1).timers, []);
  hub.execute("tick", [], at(101));
  assert.deepEqual(hub.stateOf(at(101)).timers, []);
});

test("o estado diz de onde no registro foi lido, para que um cliente continue dali no stream", () => {
  const read = hub.stateOf(at(3));
  assert.equal(read.seq, hub.logAfter(0).at(-1)!.seq);
  hub.ingest("app", { id: "after-the-state", type: "nobody.takes", subject: "#later" }, at(4));
  const since = hub.logAfter(read.seq);
  assert.ok(since.length > 0, "o que veio depois está no stream a partir dali");
  assert.equal(hub.stateOf(at(5)).seq, since.at(-1)!.seq);
});

test("os cartões do titular dizem a qual assunto se referem e o que quem perguntou deixou para si", () => {
  hub.ingest("app", { id: "card-lane", type: "feedback.new", subject: "#77" }, at(6));
  const job = hub.claimNext("w1", "card-lane", at(6))!;
  const ask = {
    title: "Devolver o dinheiro?",
    text: "Ele disse que veio com defeito",
    options: ["Devolver", "Não devolver"],
    about: "A devolução fica na terceira página do painel",
  };
  hub.finish(job.run, job.token, { outcome: "done", ask: [ask] }, at(7));
  const card = hub.stateOf(at(8)).cards.find((open: { title: string }) => open.title === ask.title)!;
  assert.equal(card.lane, "#77");
  assert.equal(card.about, ask.about);
});

test("status --json imprime o mesmo estado que a central serve, e a saída simples continua legível", async () => {
  hub.execute(
    "rules",
    [
      hub.parseRules(
        JSON.stringify({
          sources: { local: { name: "esta máquina" } },
          agents: { helper: { name: "assistente", worker: "this-machine", use: "command", command: ["true"] } },
          channels: {},
          rules: [],
        }),
        Date.now(),
      ),
    ],
    Date.now(),
  );
  const state = JSON.parse(await cli("status", "--json"));
  assert.deepEqual(Object.keys(state).sort(), Object.keys(hub.stateOf()).sort());
  assert.equal(state.timezone, hub.stateOf().timezone);
  assert.ok(Array.isArray(state.runs));
  assert.ok(Array.isArray(state.cards));
  const human = await cli("status");
  assert.ok(!human.trim().startsWith("{"));
  assert.match(human, /Em execução|Na fila|Aguardando você/);
  assert.doesNotMatch(human, /\x1b/, "sem códigos de cor quando não é um terminal");
});

test("uma flag desconhecida é recusada em vez de ignorada", async () => {
  await assert.rejects(cli("status", "--wat"), /Parâmetro não reconhecido/);
});
