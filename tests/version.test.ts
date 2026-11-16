// `agent-autoloop --version`: o que alguém cola num relatório de bug. Casos de falha: precisa de uma instalação para
// responder; um código posterior a um release continua se chamando de aquele release, como faz um número guardado num
// arquivo; uma tag de teste vence o release no mesmo commit; uma tag que não é uma versão é tomada por uma; um commit
// cuja ref foi empacotada (o estado de um clone depois de um gc) é lido como desconhecido, ou uma cópia extraída dentro
// de outro repositório é lida como o commit ou o release daquele repositório.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitOf, releaseOf, versionLine, versionName } from "../host/version.ts";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-version-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("imprime o release deste commit e o commit, sem nada instalado", () => {
  const empty = join(dir, "nothing-installed");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: empty };
  delete env.AGENT_AUTOLOOP_COMMIT;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), "--version"],
    { env, encoding: "utf8" },
  );
  assert.equal(done.status, 0, done.stderr);
  const commit = git(root, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(done.stdout.trim(), `agent-autoloop ${releaseOf(root) ?? "não publicada"} (commit ${commit})`);
  assert.ok(!existsSync(empty), "perguntar a versão não prepara nada");
});

test("a versão é a tag neste commit, e só enquanto estiver nesse commit", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const repo = join(dir, "tagged");
  mkdirSync(join(repo, "vendored"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  const head = git(repo, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(releaseOf(repo), null);
  assert.equal(versionLine(repo), `agent-autoloop não publicada (commit ${head})`);
  assert.equal(versionName(repo), head, "o que os outros programas recebem ainda diz que código é este");

  git(repo, "tag", "vendor-drop");
  assert.equal(releaseOf(repo), null, "uma tag que não é uma versão");
  git(repo, "tag", "v1.2.0-rc.1");
  assert.equal(releaseOf(repo), "v1.2.0-rc.1");
  git(repo, "tag", "v1.2.0");
  git(repo, "tag", "v1.2.0-rc.2");
  assert.equal(releaseOf(repo), "v1.2.0", "o release, não as versões de teste que viraram ele");
  assert.equal(versionLine(repo), `agent-autoloop v1.2.0 (commit ${head})`);
  assert.equal(versionName(repo), "v1.2.0");
  assert.equal(
    releaseOf(join(repo, "vendored")),
    null,
    "uma cópia dentro de um repositório não é o release daquele repositório",
  );

  git(repo, "commit", "-q", "--allow-empty", "-m", "past it");
  assert.equal(releaseOf(repo), null, "depois de um release ele não é mais aquele release");
  assert.equal(releaseOf(join(dir, "no-such-folder")), null);
  if (before !== undefined) process.env.AGENT_AUTOLOOP_COMMIT = before;
});

test("um commit é lido do mesmo jeito com a ref num arquivo ou empacotada, e a palavra de uma implantação conta", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const clone = join(dir, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "file"), "x");
  git(clone, "add", "file");
  git(clone, "commit", "-qm", "x");
  const head = git(clone, "rev-parse", "HEAD");
  assert.equal(commitOf(clone), head);
  git(clone, "pack-refs", "--all");
  assert.ok(!existsSync(join(clone, ".git", "refs", "heads", "main")));
  assert.equal(commitOf(clone), head);

  mkdirSync(join(clone, "vendored"));
  assert.equal(commitOf(join(clone, "vendored")), "dev", "uma cópia dentro de um repositório não está naquele commit");
  assert.equal(commitOf(join(dir, "no-such-folder")), "dev");

  process.env.AGENT_AUTOLOOP_COMMIT = "deployed";
  assert.equal(commitOf(clone), "deployed");
  if (before === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
  else process.env.AGENT_AUTOLOOP_COMMIT = before;
});
