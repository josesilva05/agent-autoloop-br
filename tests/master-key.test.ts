// A chave mestra assina todo link de cartão e todo token de rodada. Modos de falha: um master.key vazio ou cortado é usado como
// está, então qualquer um que veja o número e a hora de um cartão pode forjar o link dele; uma chave quebrada é substituída em
// silêncio, invalidando todo link e token sem o titular decidir; uma chave boa, com ou sem quebra de linha no fim, deixa de ser aceita.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const root = setup("master-key");
const runtime = JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href);

const start = (name: string, key?: string) => {
  const home = join(root, name);
  mkdirSync(home);
  if (key !== undefined) writeFileSync(join(home, "master.key"), key, { mode: 0o600 });
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const hub = await import(${runtime}); console.log(hub.environment.secret)`,
    ],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, encoding: "utf8" },
  );
  return { ...started, file: () => readFileSync(join(home, "master.key"), "utf8") };
};

test("uma chave mestra vazia ou cortada impede a central de iniciar e diz como resolver, deixando o arquivo intacto", () => {
  for (const [name, key] of [
    ["empty", ""],
    ["blank", "\n"],
    ["half", randomBytes(32).toString("base64url").slice(0, 20)],
    ["not-base64url", "!".repeat(43)],
  ]) {
    const started = start(name, key);
    assert.notEqual(started.status, 0, name);
    assert.match(started.stderr, /master\.key/, name);
    assert.match(started.stderr, /backup/, name);
    assert.equal(started.file(), key, `${name}: não substituída pelas costas do titular`);
  }
});

test("uma chave mestra boa funciona, com ou sem quebra de linha no fim; uma ausente é criada", () => {
  const key = randomBytes(32).toString("base64url");
  for (const [name, written] of [
    ["exact", key],
    ["newline", `${key}\n`],
  ]) {
    const started = start(name, written);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout.trim(), key, name);
  }
  const made = start("missing");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.file(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.stdout.trim(), made.file());
});
