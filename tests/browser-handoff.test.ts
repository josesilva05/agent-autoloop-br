// Modos de falha: uma tarefa vira sintaxe de shell; uma continuação cria outra sessão de navegador; uma URL ou sessão
// inválida chega ao navegador; uma ponte que falhou é reportada como sucesso ou é tentada de novo; a receita só funciona
// dentro deste repositório.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "autoloop-browser-template-"));
after(() => rmSync(root, { recursive: true, force: true }));
const session = "12345678-1234-1234-1234-123456789abc";

function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  copyFileSync(join(import.meta.dirname, "../examples/recipes/browser-handoff/handoff.ts"), join(dir, "handoff.ts"));
  const command = join(dir, "browser entry");
  writeFileSync(
    command,
    `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync('called.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
console.log('Evidência da página: título da página de exemplo');
console.log('[ID de sessão do Codex: ${session}]');
process.exit(Number(process.env.BRIDGE_EXIT || 0));
`,
    { mode: 0o755 },
  );
  const task = {
    command: [command],
    url: "https://example.com/página",
    checks: ["Verificar o título", "Preservar os literais $(touch SHOULD_NOT_EXIST) e `echo x`"],
    allowedActions: ["Somente leitura da página", "Fechar apenas as abas abertas nesta execução"],
  };
  writeFileSync(join(dir, "browser.json"), JSON.stringify(task));
  const run = (args: string[] = [], code = 0) =>
    spawnSync(process.execPath, ["handoff.ts", "browser.json", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, BRIDGE_EXIT: String(code) },
    });
  return { dir, task, run };
}

test("o launcher independente passa uma tarefa literal, preserva as evidências e retoma a sessão fornecida", () => {
  const { dir, run } = fixture();
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Evidência da página/);
  assert.ok(first.stdout.includes(session));
  assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
  const again = run(["--resume", session]);
  assert.equal(again.status, 0, again.stderr);
  const calls: string[][] = readFileSync(join(dir, "called.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls[0].length, 1);
  assert.ok(calls[0][0].includes("$(touch SHOULD_NOT_EXIST)"));
  assert.ok(calls[0][0].includes(new URL("https://example.com/página").href));
  assert.deepEqual(calls[1].slice(0, 2), ["--resume", session]);
  assert.equal(calls[1].length, 3);
});

test("argumentos de escopo ou de retomada inválidos não iniciam um navegador", () => {
  const { dir, task, run } = fixture();
  assert.notEqual(run(["--resume", "bad; command"]).status, 0);
  assert.notEqual(run(["--resume"]).status, 0);
  assert.notEqual(run(["--other"]).status, 0);
  writeFileSync(join(dir, "browser.json"), JSON.stringify({ ...task, url: "javascript:alert(1)" }));
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(dir, "called.jsonl")), false);
});

test("uma ponte que falhou mantém as evidências e o código de saída, sem nova tentativa", () => {
  const { dir, run } = fixture();
  const failed = run([], 23);
  assert.equal(failed.status, 23);
  assert.match(failed.stdout, /Evidência da página/);
  assert.equal(readFileSync(join(dir, "called.jsonl"), "utf8").trim().split("\n").length, 1);
});
