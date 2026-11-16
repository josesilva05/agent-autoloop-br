// As linhas de custo do `agent-autoloop status`, a partir dos totais por hora de conclusão da central. Casos de falha: "hoje" é
// o dia da máquina ou o do UTC e não o do fuso das regras; um preço que ninguém relatou é contado como zero, ou rodadas que não
// relataram são deixadas de lado em silêncio; uma rodada que nunca começou é contada, ou uma que só espera para tentar de novo;
// uma semana de rodadas é cortada na primeira página de 60, ou uma rodada presa na fila desde muito tempo encerra a paginação
// cedo. Uma rodada criada antes da janela de relato pode terminar hoje atrás de muitas rodadas concluídas antigas. Tokens lidos
// de um cache, uma parte pequena do preço, não são distinguidos, então um dia servido sobretudo do cache lê como muitas vezes o
// que custou.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { setup } from "./helpers.ts";
import { spendLines } from "../cli/spend.ts";
import { spendingOf } from "../host/state.ts";
import { dayStart } from "../kernel/cron.ts";

const home = setup("status-cost");
const now = Date.parse("2026-11-03T02:00:00Z"); // 10:00 em Asia/Shanghai
const ended = (at: string, usage: object | null) => ({ claimedAt: at, finishedAt: at, usage });

function spendLine(
  runs: { claimedAt: string | null; finishedAt: string | null; usage: object | null }[],
  now: number,
  timezone: string,
) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE runs (claimed_at TEXT, finished_at TEXT, usage TEXT)");
    const insert = db.prepare("INSERT INTO runs VALUES (?, ?, ?)");
    for (const run of runs) insert.run(run.claimedAt, run.finishedAt, run.usage && JSON.stringify(run.usage));
    return spendLines(
      spendingOf(<T>(sql: string, args: SQLInputValue[] = []) => db.prepare(sql).all(...args) as T[], now, timezone),
    ).join("\n");
  } finally {
    db.close();
  }
}

test("hoje é o dia das regras; cada número diz quantas rodadas não o relataram", () => {
  const runs = [
    ended("2026-11-03T01:00:00Z", { input: 5000, output: 5000, cached: 4000 }),
    ended("2026-11-03T00:30:00Z", null),
    // 01:00 do dia 3 em Xangai: hoje lá, embora ainda seja dia 2 no UTC.
    ended("2026-11-02T17:00:00Z", { input: 1000, output: 234, cost: 0.5 }),
    // 18:00 do dia 2 em Xangai: esta semana, não hoje.
    ended("2026-11-02T10:00:00Z", { input: 10000, output: 0, cost: 1 }),
    ended("2026-10-28T02:00:00Z", { input: 1, output: 1, cost: 0 }),
    // Oito dias atrás: além da semana.
    ended("2026-10-26T02:00:00Z", { input: 999999, output: 999999, cost: 99 }),
  ];
  assert.equal(
    spendLine(runs, now, "Asia/Shanghai"),
    "Hoje           3 rodadas · 11,2 mil Tokens (36% em cache; 1 rodada sem relatório) · $0.50 (2 rodadas sem relatório)\n" +
      "Últimos 7 dias 5 rodadas · 21,2 mil Tokens (19% em cache; 1 rodada sem relatório) · $1.50 (2 rodadas sem relatório)",
  );
});

test("rodadas registradas antes de o input contar o cache não mostram uma parcela maior que o todo", () => {
  // O input do Claude já deixou o cache de fora enquanto cached incluía leituras e escritas.
  const old = [ended("2026-11-03T01:00:00Z", { input: 10, output: 2, cached: 60000 })];
  assert.equal(
    spendLine(old, now, "Asia/Shanghai"),
    "Hoje           1 rodada · 12 Tokens · Custo sem relatório\nÚltimos 7 dias 1 rodada · 12 Tokens · Custo sem relatório",
  );
});

test("nada relatado é dito como nada relatado, não zero; nada executado é zero rodadas", () => {
  const quiet = [ended("2026-11-03T01:00:00Z", null), ended("2026-11-03T01:30:00Z", {})];
  assert.equal(
    spendLine(quiet, now, "Asia/Shanghai"),
    "Hoje           2 rodadas · Tokens sem relatório · Custo sem relatório\n" +
      "Últimos 7 dias 2 rodadas · Tokens sem relatório · Custo sem relatório",
  );
  assert.equal(spendLine([], now, "Asia/Shanghai"), "Hoje           0 rodadas\nÚltimos 7 dias 0 rodadas");
});

test("só rodadas que terminaram contam: nem uma em curso, nem uma esperando para tentar de novo, nem uma parada antes de começar", () => {
  const at = "2026-11-03T01:00:00Z";
  const runs = [
    { claimedAt: at, finishedAt: null, usage: null },
    { claimedAt: null, finishedAt: null, usage: { input: 5, output: 5 } },
    { claimedAt: null, finishedAt: at, usage: null },
    // Parada enquanto esperava para tentar de novo, depois de uma tentativa que de fato gastou algo.
    { claimedAt: null, finishedAt: at, usage: { input: 5, output: 5 } },
  ];
  assert.equal(
    spendLine(runs, now, "Asia/Shanghai"),
    "Hoje           1 rodada · 10 Tokens · Custo sem relatório\nÚltimos 7 dias 1 rodada · 10 Tokens · Custo sem relatório",
  );
});

test("status inclui rodadas além da primeira página, inclusive rodadas antigas que terminam hoje", async () => {
  const hub = await import("./hub.ts");
  const { serve } = await import("../host/http.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
    hub.db.close();
  });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      owner: hub.addKey("owner", "reader"),
    }),
  );
  const clock = Date.now();
  const DAY = 86400_000;
  const round = (id: string, at: number, usage: object) => {
    hub.ingest("app", { id, type: "feedback.new", subject: id }, at);
    const job = hub.claimNext("w1", `claim-${id}`, at)!;
    hub.finish(job.run, job.token, { outcome: "done", summary: "pronto", usage }, at);
  };
  // O worker dela nunca aparece: desde nove dias atrás ela está "ativa", então aparece no fim da primeira página.
  hub.ingest("ops", { id: "stuck", type: "alert.raised", subject: "stuck" }, clock - 9 * DAY);
  round("old", clock - 8 * DAY, { input: 1000, output: 0, cost: 9 });
  for (let i = 0; i < 65; i++) round(`week-${i}`, clock - 3 * DAY, { input: 10, output: 0, cost: 0.01 });
  round("today", dayStart(clock, "Asia/Shanghai") + 1, { input: 100, output: 0, cost: 1 });

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), "status"],
    { env: process.env },
  );
  const lines = stdout.split("\n");
  assert.match(lines[0], /^Aguardando você /);
  assert.deepEqual(lines.slice(1, 3), [
    "Hoje           1 rodada · 100 Tokens · $1.00",
    "Últimos 7 dias 66 rodadas · 750 Tokens · $1.65",
  ]);

  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"] as const)
    hub.fixtureClear(table);
  hub.ingest("app", { id: "long", type: "feedback.new", subject: "long" }, clock - 9 * DAY);
  const long = hub.claimNext("w1", "long", clock - 9 * DAY)!;
  for (let i = 0; i < 61; i++) round(`old-${i}`, clock - 8 * DAY, { cost: 1 });
  hub.finish(long.run, long.token, { outcome: "done", usage: { input: 1000, cost: 9 } }, clock);
  const recent = await promisify(execFile)(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), "status"],
    { env: process.env },
  );
  assert.deepEqual(recent.stdout.split("\n").slice(1, 3), [
    "Hoje           1 rodada · 1 mil Tokens · $9.00",
    "Últimos 7 dias 1 rodada · 1 mil Tokens · $9.00",
  ]);
});
