// De quanto CI uma mudança recebe. Casos de falha: uma mudança no código do kernel ou nas partes da simulação pular a simulação
// curta; uma mudança que não pode tocar no que as execuções longas cobrem esperar por elas; uma mudança no que só as execuções
// longas exercitam nunca as executar; código, ou texto que um teste lê, contar como texto e não executar nada; um arquivo que
// ninguém classificou ainda pular os testes; uma movimentação para fora de kernel/ contar só onde ele foi parar; o que chega em main
// pular os testes, então um commit cuja execução foi cancelada ou substituída nunca é verificado; um diff ilegível significar menos verificação em vez de mais.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "ci-scope.sh");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-ci-scope-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let repos = 0;
/** Um repositório cujo HEAD é o que o GitHub baixa para um PR: um merge da mudança em main. */
function merged(change: (root: string) => void) {
  const root = join(dir, `repo-${++repos}`);
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  write(root, "kernel/moved.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  git("switch", "-q", "-c", "change");
  change(root);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  git("switch", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge", "change");
  return root;
}

function write(root: string, file: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), `${repos} ${file}\n`);
}

function scope(root: string, event = "pull_request") {
  const ran = spawnSync("sh", [script], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_NAME: event },
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

const touching = (...files: string[]) =>
  merged((root) => {
    for (const file of files) write(root, file);
  });

for (const [files, expected] of [
  [["README.md"], "docs"],
  [["INSTALL.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "LICENSE"], "docs"],
  [["docs/protocol.md", ".github/pull_request_template.md"], "docs"],
  [["docs/plugins.md"], "normal"],
  [["worker/worker.ts", "cli/main.ts", "host/up.ts", "plugins/feishu/channel.ts", "tests/http.test.ts"], "normal"],
  [
    ["examples/recipes/x/README.md", "skills/agent-autoloop/SKILL.md", "scripts/x.sh", "install.sh", "bin/x.ts"],
    "normal",
  ],
  [["kernel/decide.ts"], "kernel"],
  [["protocol/rules.ts"], "kernel"],
  [["README.md", "worker/worker.ts", "kernel/decide.ts"], "kernel"],
  [["sim/random.ts", "sim/world.ts", "sim/invariants.ts"], "kernel"],
  [["sim/mutate.ts", "sim/mutation.test.ts", "sim/crash.ts", "sim/crash.test.ts"], "normal"],
  [["package.json", "package-lock.json", "tsconfig.json"], "normal"],
  [[".github/workflows/check.yml", ".github/workflows/nightly.yml"], "normal"],
  [["somewhere/new.ts"], "normal"],
  [["README.md", "kernel/decide.ts", "somewhere/new.ts"], "kernel"],
  [["tests/simulation.test.ts"], "full"],
  [["sim/enumerate.ts"], "full"],
  [["README.md", "kernel/decide.ts", "sim/enumerate.ts"], "full"],
] as const) {
  test(`um PR que altera ${files.join(", ")} recebe ${expected}`, () => {
    assert.equal(scope(touching(...files)), `scope=${expected}`);
  });
}

test("mover um arquivo para fora de kernel/ conta o lado de onde ele saiu", () => {
  const root = merged((at) => {
    mkdirSync(join(at, "docs"));
    renameSync(join(at, "kernel", "moved.ts"), join(at, "docs", "moved.md"));
  });
  assert.equal(scope(root), "scope=kernel");
});

test("o que chega em main recebe os testes rápidos, texto inclusive, e uma execução pedida à mão recebe a completa", () => {
  assert.equal(scope(touching("README.md"), "push"), "scope=normal");
  assert.equal(scope(touching("kernel/decide.ts"), "push"), "scope=normal");
  assert.equal(scope(touching("README.md"), "workflow_dispatch"), "scope=full");
});

test("um diff que não pode ser lido significa a execução completa", () => {
  const root = join(dir, "first-commit");
  mkdirSync(root);
  assert.equal(scope(root), "scope=full", "nem é um repositório");
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.equal(scope(root), "scope=full", "nada commitado");
});
