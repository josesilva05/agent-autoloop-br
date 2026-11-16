// Modos de falha: why despeja as regras ou JSON por padrão; rodadas/eventos relacionados vazam para a linha do tempo; uma
// pergunta perde a resposta ou a continuação dela; ações do recibo desaparecem; a nova tentativa usa a versão errada das
// regras; --json muda os fatos brutos; a hora local é substituída por UTC ou por um ano, colunas desalinham; um link de
// sessão provisório é apresentado depois de o Agent ter fornecido a sessão real.
import assert from "node:assert/strict";
import { rows } from "../kernel/evolve.ts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("why");
const rulesFile = join(home, "rules.json");
const rulesSaying = (prompt: string) =>
  JSON.stringify({
    sources: { shop: { name: "loja" } },
    agents: { helper: { name: "assistente", worker: "mac-mini", use: "command", command: ["true"] } },
    channels: {},
    rules: [
      {
        name: "tratar pedidos",
        when: { source: "shop", types: ["order.created"] },
        to: "helper",
        cwd: "/tmp",
        parallel: 2,
        prompt,
        emits: { source: "shop", types: ["order.done"] },
      },
    ],
  });
writeFileSync(rulesFile, rulesSaying("private-rule-instructions"));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
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
      { env: { ...process.env, TZ: "Asia/Taipei" } },
    )
  ).stdout;
const start = Date.parse("2026-11-03T00:00:00Z");

test("why imprime o evento real, a versão das regras, o worker, a sessão, o recibo, a resposta e a continuação como linha do tempo", async () => {
  hub.ingest("shop", { id: "order-42", type: "order.created", subject: "order-42" }, start + 1000);
  const job = hub.claimNext("mac-mini", "first", start + 2000)!;
  hub.started(job.run, job.token, { session: "pending", link: "https://example.com/sessions/pending" }, start + 2500);
  hub.started(job.run, job.token, { session: "example", link: "https://example.com/sessions/example" }, start + 3000);
  hub.finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "aguardando a sua escolha do modo de envio",
      ask: [
        {
          title: "Como enviar?",
          text: "Os dois modos entregam.",
          options: ["transportadora", "retirada"],
          key: "shipping",
        },
      ],
      notice: [{ title: "Pedido conferido", text: "Estoque suficiente" }],
      later: [{ key: "stock", at: "2026-11-04T00:00:00Z", about: "verificar o estoque" }],
      events: [{ id: "checked-42", type: "order.done", subject: "order-42" }],
    },
    start + 4000,
  );
  const card = rows(hub.getView(), "cards").find((c) => c.run_id === job.run && c.kind === "ask")!;
  hub.answer(card.id, { choice: 1, by: "o titular" }, start + 5000);
  const continued = hub.claimNext("mac-mini", "second", start + 6000)!;
  const output = await cli("why", String(job.run));
  for (const words of [
    "11-03 08:00:01",
    "shop",
    "order.created",
    "order-42",
    "Versão das regras",
    "mac-mini",
    "Início",
    "Fim",
    "https://example.com/sessions/example",
    "aguardando a sua escolha do modo de envio",
    "Como enviar?",
    "retirada",
    "o titular",
    "Pedido conferido",
    "verificar o estoque",
    "order.done",
    `Continua após a resposta: rodada ${continued.run}`,
  ])
    assert.ok(output.includes(words), words + "\n" + output);
  assert.ok(!output.includes("private-rule-instructions"));
  assert.ok(!output.includes('"changes"'));
  assert.ok(!output.trim().startsWith("["));
  assert.ok(!output.includes("https://example.com/sessions/pending"));
  assert.deepEqual(JSON.parse(await cli("why", String(job.run), "--json")), hub.why(job.run));
  hub.finish(continued.run, continued.token, { outcome: "done", summary: "retirada agendada" }, start + 7000);
});
test("why mantém as tentativas que falharam e usa a versão das regras de cada tentativa sem imprimir as regras", async () => {
  hub.ingest("shop", { id: "retry", type: "order.created", subject: "retry" }, start + 10000);
  const first = hub.claimNext("mac-mini", "retry-1", start + 11000)!;
  hub.finish(first.run, first.token, { outcome: "failed", error: "conexão interrompida" }, start + 12000);
  const before = hub.getView().get("config", "rules")!.version;
  writeFileSync(rulesFile, rulesSaying("changed-private-instructions"));
  hub.reloadRules();
  const afterVersion = hub.getView().get("config", "rules")!.version;
  hub.claimNext("mac-mini", "retry-2", start + 312000);
  const output = await cli("why", String(first.run));
  assert.ok(output.includes("conexão interrompida"));
  assert.ok(output.includes(`Versão das regras #${before}`));
  assert.ok(output.includes(`Versão das regras #${afterVersion}`));
  assert.ok(!output.includes("private-instructions"));
});
