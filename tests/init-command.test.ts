// `init --command` transformando o que uma pessoa digitou na linha de comando do rules.json. Modos de falha: um caminho entre
// aspas com um espaço é cortado no espaço, aspas e tudo, e instala sem dizer nada, para falhar só quando uma regra roda pela
// primeira vez; uma aspa deixada aberta é tomada como parte de uma palavra; um programa que não existe instala como se
// existisse, e daí cada rodada de cada regra falha. Roda o programa real num home próprio; nenhum serviço, central ou Agent é iniciado.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-init-command-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
function init(command: string) {
  const home = join(dir, `home-${++homes}`);
  const ran = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", program, "init", "--command", command, "--no-service"],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, encoding: "utf8", timeout: 60_000 },
  );
  return { code: ran.status, stderr: ran.stderr, home };
}

test("um caminho entre aspas com um espaço continua sendo uma palavra só, sem as aspas", () => {
  const folder = join(dir, "a folder with a space");
  mkdirSync(folder);
  const script = join(folder, "agent.mjs");
  writeFileSync(script, "console.log(process.argv.at(-1));\n");
  const ran = init(`node "${script}" '{prompt}'`);
  assert.equal(ran.code, 0, ran.stderr);
  const rules = JSON.parse(readFileSync(join(ran.home, "rules.json"), "utf8"));
  assert.deepEqual(rules.agents.agent.command, ["node", script, "{prompt}"]);
});

test("uma aspa deixada aberta o interrompe e não instala nada", () => {
  const ran = init(`node "/somewhere/agent.mjs {prompt}`);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /aspas/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("um programa que não existe o interrompe e não instala nada", () => {
  for (const missing of ["definitely-not-a-program-xyz {prompt}", `"${join(dir, "nowhere", "agent")}" {prompt}`]) {
    const ran = init(missing);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Não foi possível encontrar/);
    assert.equal(existsSync(join(ran.home, "config.json")), false);
    assert.equal(existsSync(join(ran.home, "rules.json")), false);
  }
});
