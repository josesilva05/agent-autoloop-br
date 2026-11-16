// Modos de falha: explain imprime o prompt privado de uma regra; uma simulação grava na central em vez de pré-visualizar; a
// pré-visualização ignora outra regra para o mesmo evento; um subcomando inválido é aceito em silêncio; uma simulação com a
// chave de outra fonte pré-visualiza a fonte desta máquina mesmo assim.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { explainRules, previewEvent } from "../cli/explain.ts";
import { InputError } from "../kernel/errors.ts";
import { at, setup } from "./helpers.ts";

const fixture = readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8");

test("a explicação mostra os limites de regra e de Agent independentemente", () => {
  const given = JSON.parse(fixture);
  given.rules[0].maxActive = 1;
  given.agents.a1.maxActive = 2;
  const lines = explainRules(JSON.stringify(given), at(0), "UTC");
  assert.match(
    lines.find((line) => line.startsWith("Agents: "))!,
    /a1 \([^)]+no máximo 2 rodadas simultâneas/,
  );
  assert.match(
    lines.find((line) => line.startsWith("  opiniões: "))!,
    /paralelismo 3 · no máximo 1 rodadas simultâneas nesta regra/,
  );
  assert.match(
    lines.find((line) => line.startsWith("  opiniões: "))!,
    /título de sessão note-\{id\}/,
  );
});
const home = setup("rules-preview");
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("explain lista regras, Agents, canais e próximas execuções, mas nenhum texto de prompt ou skill", () => {
  const lines = explainRules(fixture, at(0), "UTC").join("\n");
  for (const words of [
    "opiniões",
    "feedback.*",
    "a1",
    "permissão edit",
    "chat",
    "quem responde me",
    "todos os dias 09:00",
    "próxima",
    "inspeção",
  ])
    assert.ok(lines.includes(words), words + "\n" + lines);
  for (const privateText of ["Siga o manual.", "Trate o alerta.", "Registre.", "Escreva o briefing."])
    assert.ok(!lines.includes(privateText), privateText);
});

test("explain mostra os canais de uma regra, e consegue ler um arquivo de rascunho", async () => {
  const given = JSON.parse(fixture);
  given.rules[0].channels = ["chat"];
  const lines = explainRules(JSON.stringify(given), at(0), "UTC").join("\n");
  assert.match(lines, /opiniões:.*envia apenas para chat/);
  const draft = join(home, "draft.json");
  writeFileSync(draft, JSON.stringify(given));
  assert.match(await cli("rules", "explain", draft), /envia apenas para chat/);
});

test("explain diz para onde vão os cartões que não nomeiam canais", () => {
  assert.ok(!explainRules(fixture, at(0), "UTC").join("\n").includes("por padrão apenas para"));
  const given = JSON.parse(fixture);
  given.defaultChannels = ["chat"];
  assert.match(explainRules(JSON.stringify(given), at(0), "UTC").join("\n"), /por padrão apenas para chat/);
});

test("explain diz quais regras continuam na sessão da rodada anterior", () => {
  assert.ok(!explainRules(fixture, at(0), "UTC").join("\n").includes("continuando a sessão da rodada anterior"));
  const given = JSON.parse(fixture);
  given.rules[0].resume = true;
  const lines = explainRules(JSON.stringify(given), at(0), "UTC");
  assert.ok(
    lines.some((line) => line.includes("feedback.*") && line.includes("continuando a sessão da rodada anterior")),
    lines.join("\n"),
  );
});

test("uma simulação diz quais regras receberiam o evento, e não precisa de central", () => {
  assert.match(
    previewEvent(fixture, "app", { id: "1", type: "feedback.new", subject: "#1" }, at(0), "UTC").join("\n"),
    /opiniões → a1/,
  );
  const alerts = previewEvent(fixture, "ops", { id: "2", type: "alert.raised" }, at(0), "UTC").join("\n");
  assert.ok(alerts.includes("alerta → a2") && alerts.includes("alerta também registra → a1"), alerts);
  assert.match(
    previewEvent(fixture, "app", { id: "3", type: "else.new" }, at(0), "UTC").join("\n"),
    /Nenhuma regra recebe/,
  );
  assert.throws(() => previewEvent(fixture, "app", { id: "4", type: "not a type" }, at(0), "UTC"), InputError);
});

test("os comandos leem o arquivo de regras local e recusam um subcomando desconhecido", async () => {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", source: { name: "app", key: "test-only" } }),
  );
  assert.match(await cli("rules", "explain"), /opiniões/);
  const preview = await cli("emit", "feedback.new", "--dry-run", "--subject", "#1");
  assert.match(preview, /Pré-visualização/);
  assert.match(preview, /opiniões → a1/);
  await assert.rejects(cli("rules", "nope"), /Uso/);
  await assert.rejects(cli("emit", "feedback.new", "--dry-run", "--key", "another-source"), /--key/);
});
