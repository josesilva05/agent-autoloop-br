// Nomear uma rodada: `stop` e `why` sem número, ou com uma palavra que não é um, costumavam enviar /v1/runs/NaN à central e
// imprimir "não existe esse endereço", o que lê como uma central quebrada e não como um comando digitado errado. Descoberto
// aqui rodando o programa real num home em que nada foi instalado: o uso tem de vir antes de qualquer pergunta à central.
// Uma central que não responde era dita como um simples "fetch failed", sem palavra sobre qual central nem o que fazer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-run-id-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], home = join(dir, "home")) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

for (const args of [
  ["stop"],
  ["stop", "abc"],
  ["stop", "0"],
  ["stop", "1.5"],
  ["why"],
  ["why", "--json"],
  ["why", "x"],
]) {
  test(`${args.join(" ")} diz como nomear uma rodada em vez de perguntar à central`, async () => {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, new RegExp(`Uso: agent-autoloop ${args[0]} <nº da rodada>`));
  });
}

test("um número de rodada de verdade ainda segue até a central", async () => {
  for (const args of [
    ["stop", "3"],
    ["why", "3", "--json"],
    ["why", "--json", "3"],
  ]) {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.doesNotMatch(ran.stderr, /Uso/);
    assert.match(ran.stderr, /ainda não está instalado/);
  }
});

test("uma central que não responde é nomeada, com o que fazer, em vez de um simples fetch failed", async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const home = join(dir, "nobody-home");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, owner: "k" }));
  const ran = await run(["status"], home);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, new RegExp(`Não foi possível conectar à central http://127\\.0\\.0\\.1:${port}`));
  assert.match(ran.stderr, /service install/);
});
