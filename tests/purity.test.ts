// A arquitetura, como teste. O kernel da central não conhece nenhum fornecedor e não faz nenhuma requisição por conta
// própria: tudo se conecta a ele. Modos de falha: um nome de produto, uma requisição para fora, uma dependência de
// runtime ou uma interface entra no kernel; o que carrega e executa os plugins passa a conhecer um deles pelo nome,
// ou a importá-lo.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const kernel = readdirSync(join(root, "kernel"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => [f, readFileSync(join(root, "kernel", f), "utf8")] as const);

const VENDORS =
  /claude|anthropic|codex|openai|gemini|cursor|hermes|openclaw|feishu|lark|dingtalk|telegram|slack|github|gitlab|\bacp\b|\bdsh\b|\bzcode\b/i;

/** Um comentário pode dizer de onde veio um limite. */
function namesNoProduct(file: string, text: string) {
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim().startsWith("//") || line.trim().startsWith("/**")) continue;
    assert.ok(!VENDORS.test(line), `${file}:${i + 1}: ${line.trim()}`);
  }
}

test("o kernel não cita nenhum produto", () => {
  for (const [file, text] of kernel) namesNoProduct(file, text);
});

test("o que carrega e executa os plugins também não cita nenhum: um produto novo é um plugin novo", () => {
  for (const folder of ["host", "protocol", "worker"]) {
    for (const file of readdirSync(join(root, folder)).filter((name) => name.endsWith(".ts"))) {
      // O que o worker tira do ambiente de um Agent, de uma sessão em que ele mesmo pode estar: nada mais sabe.
      const text = readFileSync(join(root, folder, file), "utf8").replace("CLAUDECODE$|CLAUDE_CODE_|CODEX_", "");
      namesNoProduct(`${folder}/${file}`, text);
    }
  }
});

test("nada além do carregador alcança um plugin", () => {
  for (const folder of ["kernel", "host", "protocol", "worker", "cli"]) {
    for (const file of readdirSync(join(root, folder)).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(root, folder, file), "utf8");
      assert.ok(!/from "[^"]*plugins\//.test(text), `${folder}/${file}`);
    }
  }
});

test("o kernel não faz nenhuma requisição por conta própria", () => {
  const requests =
    /\bfetch\(|https?\.request|https?\.get\(|node:https|node:net|node:dgram|node:tls|child_process|WebSocket/;
  for (const [file, text] of kernel) assert.ok(!requests.test(text), file);
});

test("nada é instalado para executá-lo", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("não há nenhuma interface nele", () => {
  assert.ok(!existsSync(join(root, "web")));
  for (const [file, text] of kernel) assert.ok(!/<script|cookie/i.test(text), file);
});

test("tempo e entropia entram pelo host", () => {
  for (const [file, text] of kernel)
    assert.ok(
      !/Date\.now\(|new Date\(\)|Math\.random\(|randomBytes|randomUUID|process\.env|node:fs|setTimeout|setInterval/.test(
        text,
      ),
      file,
    );
});

test("só o evolve escreve projeções e só o commit acrescenta ao registro", () => {
  const production = ["kernel", "host", "protocol", "plugins", "worker", "cli"]
    .filter((name) => existsSync(join(root, name)))
    .flatMap((name) =>
      readdirSync(join(root, name), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith(".ts"))
        .map((file) => `${name}/${file}`),
    );
  for (const file of production) {
    const text = readFileSync(join(root, file), "utf8");
    if (file !== "kernel/evolve.ts") assert.ok(!/\b(INSERT INTO|UPDATE|DELETE FROM) projections/.test(text), file);
    if (file !== "kernel/store.ts") assert.ok(!/\bINSERT INTO facts/.test(text), file);
    assert.ok(!/\b(UPDATE|DELETE FROM) facts/.test(text), file);
  }
  const store = readFileSync(join(root, "kernel/store.ts"), "utf8");
  assert.ok(!/INSERT INTO facts/.test(store.slice(0, store.indexOf("export function commit("))));
});
