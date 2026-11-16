// Ler a linha de comando: `init --help` costumava instalar em vez de imprimir como se usa, e um `--port` com erro de digitação
// instalava com o padrão em silêncio; `update --help` e `uninstall --yes --help` rodavam a atualização ou a desinstalação de
// verdade; qualquer outro comando seguia em frente sem o que uma flag que ele não lê tinha pedido, e um resultado dado ao
// `resolve` não pode ser tomado por flags. Tudo encontrado aqui rodando o programa real num home próprio e olhando o que ele
// gravou. Nada é instalado, atualizado ou desinstalado, nenhum serviço é tocado e nenhum Agent é chamado.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-flags-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
type Ran = { code: number; stdout: string; stderr: string; home: string };

/** Um comando, do jeito que uma pessoa o digita, num home em que nada foi instalado ainda. */
async function run(args: string[]): Promise<Ran> {
  const home = join(dir, `home-${++homes}`);
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, timeout: 30_000 },
    );
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", home };
  }
}

test("init --help diz como se usa e não instala nada", async () => {
  const ran = await run(["init", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop init/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("init -h faz o mesmo", async () => {
  const ran = await run(["init", "-h"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /--no-service/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("uma flag que o init não lê o interrompe em vez de instalar com o padrão", async () => {
  const ran = await run(["init", "--prot", "3360", "--no-service"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Parâmetro não reconhecido: --prot/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("palavras que o init não lê também o interrompem", async () => {
  for (const args of [["-p", "3360"], ["3360"]]) {
    const ran = await run(["init", ...args, "--no-service"]);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Parâmetro não reconhecido/);
    assert.equal(existsSync(join(ran.home, "config.json")), false);
  }
});

test("as flags que o init lê ainda chegam à configuração", async () => {
  const ran = await run(["init", "--command", "node {prompt}", "--port", "3361", "--no-service"]);
  assert.equal(ran.code, 0, ran.stderr);
  const config = JSON.parse(readFileSync(join(ran.home, "config.json"), "utf8")) as { url: string };
  assert.equal(config.url, "http://127.0.0.1:3361");
});

test("try --help diz como se usa e não roda nada", async () => {
  const ran = await run(["try", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop try/);
});

test("update --help diz como se usa e não atualiza nada", async () => {
  const ran = await run(["update", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop update/);
  assert.doesNotMatch(ran.stdout, /Já está na versão mais recente|Atualização concluída/);
});

test("update -h faz o mesmo", async () => {
  const ran = await run(["update", "-h"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop update/);
});

test("uma flag que o update não lê o interrompe em vez de atualizar", async () => {
  const ran = await run(["update", "--yse"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Parâmetro não reconhecido: --yse/);
});

test("uninstall --help diz como se usa e não desinstala nada", async () => {
  const ran = await run(["uninstall", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop uninstall/);
  assert.match(ran.stdout, /--yes/);
});

test("uninstall --yes --help imprime o uso e não desinstala nada", async () => {
  const ran = await run(["uninstall", "--yes", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /Uso: agent-autoloop uninstall/);
  assert.doesNotMatch(ran.stdout + ran.stderr, /Desinstalação concluída|Nada foi desinstalado|Removido:/);
});

test("uma flag que o uninstall não lê o interrompe em vez de desinstalar", async () => {
  const ran = await run(["uninstall", "--yse"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Parâmetro não reconhecido: --yse/);
});

const EVERY_OTHER_COMMAND = [
  "add",
  "answer",
  "ask",
  "backup",
  "check",
  "conformance",
  "doctor",
  "emit",
  "join",
  "key",
  "mcp",
  "restore",
  "rules",
  "service",
  "status",
  "stop",
  "tell",
  "try",
  "up",
  "why",
];

for (const command of EVERY_OTHER_COMMAND) {
  test(`${command} para numa flag que não lê, e diz como se usa quando perguntado`, async () => {
    const wrong = await run([command, "--nonsense"]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /Parâmetro não reconhecido: --nonsense/);
    const asked = await run([command, "--help"]);
    assert.equal(asked.code, 0);
    assert.match(asked.stdout, new RegExp(`Uso: agent-autoloop ${command}`));
    assert.equal(existsSync(join(asked.home, "config.json")), false);
  });
}

test("resolve aceita um resultado nas palavras de alguém, traços e tudo", async () => {
  const words = await run(["resolve", "3", "--not", "a", "flag"]);
  assert.doesNotMatch(words.stderr, /Parâmetro não reconhecido/);
  const asked = await run(["resolve", "--help"]);
  assert.equal(asked.code, 0);
  assert.match(asked.stdout, /Uso: agent-autoloop resolve/);
});

test("--help e -h sozinhos dizem como se usa", async () => {
  for (const flag of ["--help", "-h"]) {
    const ran = await run([flag]);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /agent-autoloop init/);
  }
});
