// `agent-autoloop uninstall`, executado a partir de uma cópia do programa organizada como uma instalação, num home
// descartável com substitutos para launchctl e systemctl: nada real pode ser alcançado. Casos de falha: o serviço
// continua rodando, ou um iniciado à mão continua; um processo que só tem o número antigo é morto; um link é deixado
// para trás, em ~/.local/bin, em outro lugar do PATH ou entre os Skills dos Agents, ou reinstalar sobre os dados
// preservados não os traz de volta; um arquivo, pasta ou link de outra pessoa com o mesmo nome é removido, ou um link
// que leva a outro lugar; os dados são apagados pelo uninstall ou pelo --yes; sem ninguém num terminal ele trava na
// pergunta; um AGENT_AUTOLOOP_HOME apontando o home do usuário, ou uma pasta que este programa não criou, faz isso ser apagado.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-uninstall-")));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

let people = 0;
/** Alguém com uma instalação no lugar de costume, coisas próprias ao redor dela, e links como o script de instalação os faz. */
function install() {
  const person = join(dir, `person-${++people}`);
  const hub = join(person, ".agent-autoloop");
  const app = join(hub, "app");
  for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
    cpSync(join(repo, part), join(app, part), { recursive: true });
  }
  const standIns = join(person, "stand-ins");
  const called = join(person, "service-calls");
  mkdirSync(standIns, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(standIns, name), `#!/bin/sh\necho "${name} $*" >> "${called}"\nexit 1\n`);
    chmodSync(join(standIns, name), 0o755);
  }
  const elsewhere = join(person, "elsewhere");
  const mine = join(person, "mine");
  const theirs = join(person, "theirs");
  const dangling = join(person, "dangling");
  for (const place of [join(person, ".local", "bin"), elsewhere, mine, theirs, dangling]) {
    mkdirSync(place, { recursive: true });
  }
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: person,
    PATH: [standIns, join(person, ".local", "bin"), elsewhere, mine, theirs, dangling, "/usr/bin", "/bin"].join(":"),
  };
  for (const name of [
    "AGENT_AUTOLOOP_HOME",
    "AGENT_AUTOLOOP_RULES",
    "AGENT_AUTOLOOP_PUBLIC_URL",
    "AGENT_AUTOLOOP_COMMIT",
  ])
    delete env[name];
  const program = join(app, "bin", "agent-autoloop.ts");
  const run = (args: string[], over: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", program, ...args], {
      env: { ...env, ...over },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const set = run(["init", "--no-service", "--command", "true", "--port", "3999"]);
  assert.equal(set.status, 0, set.stderr);
  symlinkSync(program, join(person, ".local", "bin", "agent-autoloop"));
  symlinkSync(program, join(elsewhere, "agent-autoloop"));
  writeFileSync(join(mine, "agent-autoloop"), "#!/bin/sh\necho mine\n");
  symlinkSync(join(mine, "agent-autoloop"), join(theirs, "agent-autoloop"));
  symlinkSync(join(person, "gone"), join(dangling, "agent-autoloop"));
  return { person, hub, app, env, run, called, elsewhere, mine, theirs, dangling, program };
}
type Install = ReturnType<typeof install>;
const skillLink = ({ person }: Install) => join(person, ".claude", "skills", "agent-autoloop");
const isThere = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

function ownThingsAreThere(it: Install) {
  assert.equal(readFileSync(join(it.mine, "agent-autoloop"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(readlinkSync(join(it.theirs, "agent-autoloop")), join(it.mine, "agent-autoloop"));
  assert.equal(readlinkSync(join(it.dangling, "agent-autoloop")), join(it.person, "gone"));
  assert.equal(readFileSync(join(it.person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
}

function linksAreGone(it: Install) {
  assert.ok(!isThere(join(it.person, ".local", "bin", "agent-autoloop")));
  assert.ok(!isThere(join(it.elsewhere, "agent-autoloop")));
  assert.ok(!isThere(skillLink(it)));
}

test("o que a instalação cria é o que ela tira: serviço parado, links removidos, todos os dados sempre preservados", () => {
  const it = install();
  assert.ok(lstatSync(skillLink(it)).isSymbolicLink(), "o init ligou o Skill");
  const service =
    process.platform === "darwin"
      ? join(it.person, "Library", "LaunchAgents", "agent-autoloop.plist")
      : join(it.person, ".config", "systemd", "user", "agent-autoloop.service");
  mkdirSync(join(service, ".."), { recursive: true });
  writeFileSync(service, `<string>${it.program}</string>`);

  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  const calls = readFileSync(it.called, "utf8");
  if (process.platform === "darwin")
    assert.match(calls, new RegExp(`launchctl bootout gui/${process.getuid!()}/agent-autoloop$`, "m"));
  else assert.match(calls, /^systemctl --user disable --now agent-autoloop$/m);
  assert.ok(!existsSync(service));
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(join(it.hub, "config.json")), "ninguém estava lá para dizer sim, então os dados ficam");
  assert.match(done.stdout, /Regras, chaves e registros continuam em/);
  assert.ok(!existsSync(it.app), "o código instalado é removido");
});

test("--yes pula a confirmação e preserva todos os dados", () => {
  const it = install();
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(join(it.hub, "config.json")));
  assert.ok(!existsSync(it.app));
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(it.person));
});

test("num terminal, só confirmar remove o programa, e qualquer resposta preserva os dados", () => {
  const answering = (it: Install, words: string) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { uninstall } = await import(${JSON.stringify(join(it.app, "cli", "uninstall.ts"))});
         await uninstall(false, async () => ${JSON.stringify(words)});`,
      ],
      { env: it.env, encoding: "utf8", timeout: 30_000 },
    );
  for (const [words, gone] of [
    ["", false],
    ["n", false],
    ["\n", false],
    ["y", true],
    ["Yes\n", true],
  ] as const) {
    const it = install();
    const done = answering(it, words);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(existsSync(it.hub), JSON.stringify(words));
    assert.equal(existsSync(it.app), !gone);
    if (gone) linksAreGone(it);
  }
});

test("instalar o serviço de novo traz de volta um link de Skill que a desinstalação tirou", () => {
  const it = install();
  // Não rmSync: no Node 25.1 ele se recusa a remover um link que leva a uma pasta.
  unlinkSync(skillLink(it));
  // O gerenciador de serviços substituto se recusa; o link vem primeiro.
  it.run(["service", "install"]);
  assert.ok(lstatSync(skillLink(it)).isSymbolicLink());
});

test("uma central iniciada à mão também é parada; um processo que só tem o número antigo, não", async () => {
  const it = install();
  const asIfUp = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "agent-autoloop", "up"], {
    stdio: "ignore",
  });
  children.push(asIfUp);
  writeFileSync(join(it.hub, "up.pid"), String(asIfUp.pid));
  const stopped = new Promise((resolve) => asIfUp.on("exit", resolve));
  assert.equal(it.run(["uninstall", "--yes"]).status, 0);
  await stopped;

  const other = install();
  const someoneElse = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  children.push(someoneElse);
  writeFileSync(join(other.hub, "up.pid"), String(someoneElse.pid));
  assert.equal(other.run(["uninstall", "--yes"]).status, 0);
  assert.equal(someoneElse.exitCode, null);
  assert.equal(someoneElse.signalCode, null);
});

test("AGENT_AUTOLOOP_HOME pode nomear qualquer coisa: uma pasta que este programa não criou, ou o home do usuário, não é apagada", () => {
  const it = install();
  const projects = join(it.person, "projects");
  mkdirSync(projects);
  writeFileSync(join(projects, "thesis.txt"), "years of work");
  const inFolder = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: projects });
  assert.equal(inFolder.status, 0, inFolder.stderr);
  assert.equal(readFileSync(join(projects, "thesis.txt"), "utf8"), "years of work");
  assert.ok(existsSync(projects));

  writeFileSync(join(it.person, "config.json"), "{}");
  assert.equal(it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: it.person }).status, 0);
  assert.ok(existsSync(join(it.person, "config.json")));
  assert.ok(existsSync(join(it.hub, "config.json")));
});

test("sem nada instalado ele ainda termina, e diz isso com clareza", () => {
  const it = install();
  const nothing = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: join(it.person, "never") });
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /Desinstalação concluída/);
});

test("sem um terminal, o uninstall pede --yes antes de remover qualquer coisa", () => {
  const it = install();
  const done = it.run(["uninstall"]);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /--yes/);
  assert.ok(existsSync(it.app));
  assert.ok(isThere(join(it.person, ".local", "bin", "agent-autoloop")));
});

test("um arquivo de serviço sem relação com o mesmo nome é deixado em execução e intacto", () => {
  const it = install();
  const service =
    process.platform === "darwin"
      ? join(it.person, "Library/LaunchAgents/agent-autoloop.plist")
      : join(it.person, ".config/systemd/user/agent-autoloop.service");
  mkdirSync(join(service, ".."), { recursive: true });
  writeFileSync(service, "another program");
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(service, "utf8"), "another program");
  assert.ok(!existsSync(it.called));
});
