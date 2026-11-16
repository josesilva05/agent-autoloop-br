// `check` lê um arquivo de regras e nada mais. Casos de falha: conferir um rascunho abre o banco de dados da central, cria uma
// chave mestra, ou carrega o rascunho na central em execução como se fossem as regras dela; só o arquivo de regras instalado
// pode ser conferido; um arquivo inválido passa, ou um arquivo ausente quebra em vez de dizer o que houve.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-check-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fixture = readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8");
const draft = join(home, "draft.json");
writeFileSync(draft, fixture);

const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const clean = { ...process.env, ...env };
  delete clean.AGENT_AUTOLOOP_RULES;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: "utf8",
  });
};
const facts = (hubHome: string) => {
  const db = new DatabaseSync(join(hubHome, "hub.db"), { readOnly: true });
  try {
    return [Number(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n), db.prepare("SELECT fact FROM facts").all()];
  } finally {
    db.close();
  }
};

test("conferir qualquer arquivo não toca em nenhuma central: sem banco de dados, sem chave, nada gravado", () => {
  const empty = join(home, "empty-home");
  const done = cli({ AGENT_AUTOLOOP_HOME: empty }, "check", draft);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Regras OK/);
  assert.ok(!existsSync(empty) || readdirSync(empty).length === 0, "o home fica como estava");
});

test("conferir um rascunho ao lado de uma central deixa o registro dela como estava", () => {
  const hubHome = join(home, "hub-home");
  // Uma central com as próprias regras e um registro, do jeito que `key new` a cria.
  const made = cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: draft }, "key", "new", "owner", "owner");
  assert.equal(made.status, 0, made.stderr);
  const before = facts(hubHome);
  const changed = JSON.parse(fixture);
  changed.rules.pop();
  const other = join(home, "other.json");
  writeFileSync(other, JSON.stringify(changed));
  assert.equal(cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: draft }, "check", other).status, 0);
  // O check antigo carregava na central o arquivo que conferia: este aqui difere do que a central executa.
  assert.equal(cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: other }, "check").status, 0);
  assert.deepEqual(facts(hubHome), before, "nenhum fato de regras, nenhum fato");
});

test("sem um arquivo ele confere as regras instaladas; um arquivo inválido ou ausente falha e diz o porquê", () => {
  const installed = join(home, "installed");
  const plain = cli({ AGENT_AUTOLOOP_HOME: installed }, "check");
  assert.equal(plain.status, 1);
  assert.ok(plain.stderr.includes(`Não foi possível ler ${join(installed, "rules.json")}`));
  const bad = JSON.parse(fixture);
  bad.rules[0].colour = "red";
  const badFile = join(home, "bad.json");
  writeFileSync(badFile, JSON.stringify(bad));
  const refused = cli({ AGENT_AUTOLOOP_HOME: installed }, "check", badFile);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /a regra "opiniões".*tem o campo desconhecido colour/);
  assert.ok(!existsSync(join(installed, "hub.db")));
});
