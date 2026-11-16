// Quando uma inicialização precisa reconstruir a projeção a partir do registro. Casos de falha: uma mudança em código fora dos
// arquivos que decidem o que é gravado faz o próximo upgrade esperar por uma reconstrução; uma mudança que decide isso (como os
// fatos são gravados, o que é indexado, também por um auxiliar ou uma constante, como os links de cartão são derivados, a chave
// mestra) deixa a projeção antiga em uso; uma mudança nas visões somente de leitura não aparece até que outra coisa traga uma reconstrução.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-format-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const code = join(dir, "code");
for (const name of ["kernel", "host", "protocol", "package.json"])
  cpSync(join(root, name), join(code, name), { recursive: true });
const home = join(dir, "home");

/** Inicia esta cópia do código como um processo novo faz, e diz qual formato ela gravou. */
function start() {
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(code, "host", "runtime.ts")).href)});`,
    ],
    {
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(root, "tests", "rules.fixture.json"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(started.status, 0, started.stderr);
  const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  const { format } = db.prepare("SELECT format FROM projection_meta").get() as { format: string };
  db.close();
  return format;
}

/** O formato com esta edição aplicada, que depois é retirada de novo. */
function formatWith(file: string, before: string, after: string) {
  const path = join(code, file);
  const original = readFileSync(path, "utf8");
  assert.ok(original.includes(before), `não encontrado em ${file}: ${before}`);
  writeFileSync(path, original.replace(before, after));
  try {
    return start();
  } finally {
    writeFileSync(path, original);
  }
}

test("uma inicialização sem nada alterado mantém o formato que gravou", () => {
  assert.equal(start(), start());
});

test("o que não decide o que é gravado pode mudar sem reconstrução", () => {
  const usual = start();
  for (const [file, before, after] of [
    ["host/runtime.ts", "export const listKeys", "// a comment\nexport const listKeys"],
    ["host/runtime.ts", "const { problem } = reloadRules();", 'const { problem } = reloadRules(); void "other work";'],
    ["kernel/decide.ts", "const MAX_ATTEMPTS = 10;", "const MAX_ATTEMPTS = 11;"],
    ["host/state.ts", 'summary error usage"', 'summary error usage extra"'],
  ] as const) {
    assert.equal(formatWith(file, before, after), usual, `${file}: ${after}`);
  }
});

test("o que decide o que é gravado traz uma reconstrução", () => {
  const usual = start();
  for (const [file, before, after] of [
    ["kernel/evolve.ts", "let seq = view.seq;", 'let seq = view.seq;\n  void "stored differently";'],
    ["kernel/evolve.ts", 'due: [["at"]],', 'due: [["at", "kind"]],'],
    ["kernel/evolve.ts", 'if (table === "run_events")', 'if (table === "run_events" && row)'],
    ["kernel/credentials.ts", 'createHmac("sha256", env.secret)', 'createHmac("sha512", env.secret)'],
    [
      "kernel/evolve.ts",
      "const field = (name: string) => `json_extract(data,'$.${name}')`;",
      "const field = (name: string) => `(data->>'$.${name}')`;",
    ],
    [
      "kernel/evolve.ts",
      '["events", "runs", "cards", "timers"]',
      '["events", "runs", "cards", "timers", "deliveries"]',
    ],
    [
      "kernel/credentials.ts",
      'digest(credential(env, "card", id, at))',
      'digest("other" + credential(env, "card", id, at))',
    ],
    ["host/runtime.ts", "WHERE collection='cards'\"", "WHERE collection='cards' AND 1\""],
  ] as const) {
    assert.notEqual(formatWith(file, before, after), usual, `${file}: ${after}`);
  }
  const key = join(home, "master.key");
  const original = readFileSync(key, "utf8");
  writeFileSync(key, "A".repeat(43));
  try {
    assert.notEqual(start(), usual, "outra chave mestra deriva outros links de cartão");
  } finally {
    writeFileSync(key, original);
  }
});

test("uma mudança nas visões somente de leitura aparece na próxima inicialização, sem reconstrução", () => {
  const usual = start();
  const path = join(code, "host", "state.ts");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace('summary error usage"', 'summary error usage rules_version"'));
  try {
    assert.equal(start(), usual);
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    assert.doesNotThrow(() => db.prepare("SELECT rules_version FROM runs").all());
    db.close();
  } finally {
    writeFileSync(path, original);
    start();
  }
});
