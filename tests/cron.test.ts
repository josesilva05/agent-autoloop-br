// Quando um agendamento vem a seguir, no fuso horário das regras. Casos de falha: um agendamento malformado é aceito;
// 7 não é domingo; um dia do mês e um dia da semana dados juntos não aceitam nenhum dos dois; o relógio é lido no fuso
// errado; um instante que não existe no dia em que os relógios adiantam dispara deslocado, e um que acontece duas vezes
// no dia em que atrasam dispara duas vezes; um agendamento que nunca chega (30 de fevereiro) nunca retorna.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, latestBefore, nextRun, parseCron } from "../kernel/cron.ts";

const next = (text: string, after: string, zone = "Asia/Shanghai") => {
  const at = nextRun(parseCron(text)!, Date.parse(after), zone);
  return at === null ? null : new Date(at).toISOString();
};

test("os agendamentos são interpretados com rigor", () => {
  for (const bad of [
    "",
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "a * * * *",
    "5-1 * * * *",
    "*/0 * * * *",
  ]) {
    assert.equal(parseCron(bad), null, bad);
  }
  assert.ok(parseCron("*/5 1,2 1-5 * 0,7"));
});

test("o próximo horário é lido no fuso das regras, estritamente depois do instante dado", () => {
  assert.equal(next("0 9 * * *", "2026-10-18T00:59:00Z"), "2026-10-18T01:00:00.000Z");
  assert.equal(next("0 9 * * *", "2026-10-18T01:00:00Z"), "2026-10-19T01:00:00.000Z");
  assert.equal(next("0 9 * * *", "2026-10-18T01:00:00Z", "America/New_York"), "2026-10-18T13:00:00.000Z");
  assert.equal(next("*/5 * * * *", "2026-10-18T01:02:30Z"), "2026-10-18T01:05:00.000Z");
});

test("dias da semana e dias do mês funcionam como no cron", () => {
  assert.equal(next("0 6 * * 7", "2026-10-18T00:00:00Z"), "2026-10-24T22:00:00.000Z", "domingo 06:00 em Asia/Shanghai");
  assert.equal(next("0 6 * * 0", "2026-10-18T00:00:00Z"), "2026-10-24T22:00:00.000Z");
  // 2026-10-20 é uma terça-feira e vem antes do dia 25: qualquer um dos dois casa quando ambos são dados.
  assert.equal(next("0 0 25 * 2", "2026-10-18T00:00:00Z", "UTC"), "2026-10-20T00:00:00.000Z");
  assert.equal(next("0 0 1 1 *", "2026-10-18T00:00:00Z", "UTC"), "2027-01-01T00:00:00.000Z");
});

test("um instante que não existe é pulado, e um que acontece duas vezes roda só na primeira", () => {
  // Nova York, 2026-03-08: 02:30 não existe. 2026-11-01: 01:30 acontece duas vezes (05:30Z e depois 06:30Z).
  assert.equal(next("30 2 8 3 *", "2026-03-01T00:00:00Z", "America/New_York"), "2027-03-08T07:30:00.000Z");
  assert.equal(next("30 1 1 11 *", "2026-10-31T00:00:00Z", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.equal(next("30 1 1 11 *", "2026-11-01T05:30:00Z", "America/New_York"), "2027-11-01T05:30:00.000Z");
});

test("um agendamento que nunca chega diz isso", () => {
  assert.equal(next("0 0 30 2 *", "2026-01-01T00:00:00Z"), null);
});

test("a última ocorrência vencida é achada num intervalo longo sem percorrer cada minuto dele", () => {
  const started = Date.now();
  const latest = latestBefore(
    parseCron("* * * * *")!,
    Date.parse("2020-01-01T00:00:00Z"),
    Date.parse("2026-10-18T01:02:30Z"),
    "UTC",
  );
  assert.equal(new Date(latest).toISOString(), "2026-10-18T01:02:00.000Z");
  assert.ok(Date.now() - started < 1000);
  const monthly = latestBefore(
    parseCron("0 0 1 * *")!,
    Date.parse("2026-07-01T00:00:00Z"),
    Date.parse("2026-10-18T00:00:00Z"),
    "UTC",
  );
  assert.equal(new Date(monthly).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("agendamentos comuns são lidos em palavras simples", () => {
  assert.equal(describeCron("0 18 * * *"), "todos os dias 18:00");
  assert.equal(describeCron("0 6 * * 0"), "todo dom 06:00");
  assert.equal(describeCron("0 9 * * 1-5"), "dias úteis 09:00");
  assert.equal(describeCron("0 4 1 * *"), "dia 1 de cada mês 04:00");
  assert.equal(describeCron("*/5 * * * *"), "*/5 * * * *");
});
