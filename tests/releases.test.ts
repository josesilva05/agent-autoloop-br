// O que alguém instalando ou atualizando recebe. Casos de falha: a pessoa recebe a main como está, verificada ou não, em
// vez do Release mais novo; números de versão são ordenados como texto, então v1.9.0 vence v1.10.0; uma tag que não é um
// Release é tomada por um; uma instalação feita antes dos Releases, parada na main, é deixada lá; uma cópia de um
// repositório informado à mão é enviada a tags que nunca lhe pediram para seguir, ou é sobrescrita pelo instalador e
// fica sem conseguir atualizar; uma consulta aos Releases que falha conta como estando em dia ou como não havendo
// nenhum, o que instalaria a main, ou uma atualização sem novidade reinicia o serviço; a instalação diz algo sobre HEAD
// desanexado; uma cópia que baixou só a própria tag não consegue dizer qual Release é. Sem rede: o insteadOf do próprio
// git aponta o endereço público para um repositório criado aqui.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { updateCode } from "../cli/update.ts";
import { releaseOf } from "../host/version.ts";

const PUBLISHED = "https://github.com/josesilva05/agent-autoloop-br.git";
const script = join(import.meta.dirname, "..", "install.sh");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-releases-")));
after(() => rmSync(dir, { recursive: true, force: true }));

const original = join(dir, "published");
const gitConfig = join(dir, "gitconfig");
writeFileSync(
  gitConfig,
  `[url "file://${original}"]\n\tinsteadOf = ${PUBLISHED}\n[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** O que está publicado: um programa que só diz que foi executado, um commit para cada versão, e a main à frente de todos. */
mkdirSync(join(original, "bin"), { recursive: true });
git(original, "init", "-q");
function publish(words: string, tag?: string) {
  const program = join(original, "bin", "agent-autoloop.ts");
  writeFileSync(program, `#!/bin/sh\necho "${words} $*" >> "$RAN"\n`);
  chmodSync(program, 0o755);
  git(original, "add", "-A");
  git(original, "commit", "-q", "-m", words);
  if (tag) git(original, "tag", tag);
  return git(original, "rev-parse", "HEAD");
}
const versions: Record<string, string> = {};
for (const tag of ["v1.2.0", "v1.9.0", "v1.10.0"]) versions[tag] = publish(tag, tag);
publish("a test tag", "v2.0.0-rc1");
publish("a non-release tag", "local-backup");
const tip = publish("main, not released");

let copies = 0;
const copy = (...args: string[]) => {
  const target = join(dir, `copy-${++copies}`);
  git(dir, "clone", "-q", "--depth", "1", ...args, target);
  return target;
};
const at = (root: string) => git(root, "rev-parse", "HEAD");

test("uma atualização vai para o Release mais novo, pelo número de versão, não para a main", () => {
  const root = copy("--branch", "v1.2.0", PUBLISHED);
  const done = updateCode(root);
  assert.deepEqual(done, { changed: true, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
  assert.equal(releaseOf(root), "v1.10.0");
});

test("sem nada mais novo, ele diz isso, e nada mudou", () => {
  const root = copy("--branch", "v1.10.0", PUBLISHED);
  assert.deepEqual(updateCode(root), { changed: false, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
  assert.equal(releaseOf(root), "v1.10.0");
});

test("uma instalação feita antes dos Releases troca a main pelo Release mais novo", () => {
  const root = copy(PUBLISHED);
  assert.equal(at(root), tip);
  assert.deepEqual(updateCode(root), { changed: true, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
});

test("uma cópia de um repositório informado à mão segue aquele repositório", () => {
  const root = copy(`file://${original}`);
  const before = at(root);
  assert.equal(before, tip);
  const moreRecent = publish("newer on main");
  assert.deepEqual(updateCode(root), { changed: true, to: null });
  assert.equal(at(root), moreRecent);
  assert.deepEqual(updateCode(root), { changed: false, to: null });
});

test("uma consulta aos Releases que falha é uma falha, não a notícia de que nada mudou", () => {
  const root = copy("--branch", "v1.9.0", PUBLISHED);
  git(root, "config", "remote.origin.url", PUBLISHED);
  writeFileSync(gitConfig, readFileSync(gitConfig, "utf8").replace(`file://${original}`, `file://${dir}/nowhere`));
  try {
    assert.throws(() => updateCode(root));
    assert.equal(at(root), versions["v1.9.0"]);
  } finally {
    writeFileSync(gitConfig, readFileSync(gitConfig, "utf8").replace(`file://${dir}/nowhere`, `file://${original}`));
  }
});

/**
 * O install.sh como alguém o executa: seu `git` é real, e o programa que ele instala só diz que foi executado. O PATH
 * contém apenas pastas deste próprio teste, porque o script coloca seu comando na primeira em que consegue escrever.
 */
function runInstaller(person: string, env: NodeJS.ProcessEnv = {}) {
  const ran = join(person, "ran");
  const bin = join(person, "bin");
  const tools = join(person, "tools");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const found = (name: string) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  for (const name of ["git", "node", "mkdir", "ln", "cat", "chmod", "sed", "sort", "tail"]) {
    if (!existsSync(join(tools, name))) symlinkSync(found(name), join(tools, name));
  }
  return spawnSync("/bin/sh", [script, "--no-service"], {
    env: {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: person,
      PATH: `${bin}:${tools}`,
      RAN: ran,
      AGENT_AUTOLOOP_HOME: join(person, "hub"),
      ...env,
    },
    encoding: "utf8",
  });
}

function install(person: string, env: NodeJS.ProcessEnv = {}) {
  const done = runInstaller(person, env);
  assert.equal(done.status, 0, done.stderr);
  return {
    app: join(person, "hub", "app"),
    said: () => readFileSync(join(person, "ran"), "utf8"),
    out: done.stdout,
    err: done.stderr,
  };
}

test("o instalador instala o Release mais novo, e rodá-lo de novo passa para um mais recente", () => {
  const person = join(dir, "someone");
  mkdirSync(person);
  const first = install(person);
  assert.equal(at(first.app), versions["v1.10.0"]);
  assert.match(first.said(), /^v1\.10\.0 init --no-service/);
  assert.doesNotMatch(first.out + first.err, /detached/i);

  writeFileSync(join(person, "hub", "config.json"), "{}");
  const newer = publish("v1.11.0", "v1.11.0");
  const again = install(person);
  assert.equal(at(again.app), newer);
  assert.match(again.out, /Atualização concluída/);
  assert.equal(existsSync(join(again.app, ".git")), true);
});

test("um repositório informado ao instalador à mão é instalado como está", () => {
  const person = join(dir, "by-hand");
  mkdirSync(person);
  const expected = at(original);
  const it = install(person, { AGENT_AUTOLOOP_REPO: `file://${original}` });
  assert.equal(at(it.app), expected);
});

test("o instalador para quando não consegue consultar os Releases, em vez de instalar a main", () => {
  const person = join(dir, "no-look");
  mkdirSync(join(person, "tools"), { recursive: true });
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const git = join(person, "tools", "git");
  writeFileSync(git, `#!/bin/sh\n[ "$1" = ls-remote ] && exit 128\nexec "${real}" "$@"\n`);
  chmodSync(git, 0o755);
  const done = runInstaller(person);
  assert.notEqual(done.status, 0);
  assert.equal(existsSync(join(person, "hub", "app")), false);
});

test("o instalador rodado sobre uma cópia vinda de outro lugar a deixa seguindo aquele lugar, e o update continua funcionando", () => {
  const person = join(dir, "over-by-hand");
  mkdirSync(person);
  const it = install(person, { AGENT_AUTOLOOP_REPO: `file://${original}` });
  writeFileSync(join(person, "hub", "config.json"), "{}");
  const newer = publish("newer still, on main");
  install(person);
  assert.equal(at(it.app), newer, "não foi enviada a um Release");
  assert.equal(git(it.app, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.deepEqual(updateCode(it.app), { changed: false, to: null });
});
