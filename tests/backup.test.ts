// Modos de falha: um backup ou a verificação dele falha no banco de dados de uma central real, cujos índices chamam funções que
// só a central tem; um backup feito com a central em execução perde o que está no WAL; uma restauração deixa o WAL antigo ao
// lado do banco novo, ou descarta o que só está no WAL da pasta que ela lê; um master.key ou banco quebrado é restaurado; uma
// restauração que falha perde o que substituiu, WAL incluído; a restauração roda enquanto qualquer coisa tem o banco aberto,
// incluindo uma central iniciada de outro jeito ou entre requisições; um banco quebrado demais para ser lido interrompe a
// restauração que o substituiria; uma restauração roda sem ser confirmada.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { powershell, psQuote } from "../host/command.ts";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { at, setup } from "./helpers.ts";

const home = setup("backup");
const hub = await import("./hub.ts");
const { backup, restore } = await import("../cli/backup.ts");

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-backup-"));
after(() => {
  if (hub.db.isOpen) hub.db.close();
  rmSync(scratch, { recursive: true, force: true });
});
let folders = 0;
const folder = () => {
  const made = join(scratch, `folder-${++folders}`);
  mkdirSync(made);
  return made;
};
const privateMode = (file: string, expected: number) => {
  if (process.platform !== "win32") return assert.equal(statSync(file).mode & 0o777, expected);
  const allowed = powershell(
    `$acl = [IO.${statSync(file).isDirectory() ? "Directory" : "File"}]::GetAccessControl(${psQuote(file)}); ($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) -join ','`,
  ).split(",");
  const owner = powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  assert.ok(allowed.length && allowed.every((sid) => sid === owner || sid === "S-1-5-18"), allowed.join(","));
};
const rows = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n;
  } finally {
    db.close();
  }
};
const key = "k".repeat(43);

/** Um banco com uma linha no arquivo e outra só no WAL, como deixa uma central que foi morta. */
function withWal(into: string) {
  const live = new DatabaseSync(join(scratch, `live-${++folders}.db`));
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(seq INTEGER PRIMARY KEY); INSERT INTO facts VALUES (1);");
  live.exec("PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO facts VALUES (2);");
  const name = live.location()!;
  copyFileSync(name, join(into, "hub.db"));
  copyFileSync(`${name}-wal`, join(into, "hub.db-wal"));
  live.close();
  writeFileSync(join(into, "master.key"), `${key}\n`, { mode: 0o600 });
}

test("os dados de uma central real, com backup feito enquanto ela roda, voltam inteiros sob a própria chave", async () => {
  hub.ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const target = join(folder(), "snapshot");
  const { files } = await backup(home, target);
  assert.ok(files.includes("hub.db") && files.includes("master.key"), files.join());
  privateMode(join(target, "hub.db"), 0o600);
  privateMode(join(target, "master.key"), 0o600);
  const { n } = hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!;
  assert.ok(n > 0);
  assert.equal(rows(join(target, "hub.db")), n);
  await assert.rejects(backup(home, target), /não está vazio/);

  const other = folder();
  await restore(other, target);
  assert.equal(readFileSync(join(other, "master.key"), "utf8"), readFileSync(join(home, "master.key"), "utf8"));
  // Iniciado nos arquivos restaurados, como a central seria: ele abre, e sabe o que a primeira sabia.
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const hub = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)});
       console.log(JSON.stringify(hub.stateOf().runs.map((run) => run.id)));`,
    ],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: other }, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(
    JSON.parse(started.stdout),
    hub.stateOf().runs.map((run: { id: number }) => run.id),
  );
});

test("um backup numa pasta vazia que já existe a torna privada: ela guarda as chaves", async () => {
  const target = join(folder(), "made-beforehand");
  mkdirSync(target);
  chmodSync(target, 0o755);
  await backup(home, target);
  privateMode(target, 0o700);
});

test("uma restauração preserva o que substituiu, e o WAL antigo não fica ao lado do banco novo", async () => {
  const source = folder();
  withWal(source);
  const target = folder();
  withWal(target);
  writeFileSync(join(target, "config.json"), "{}");
  const backedUp = join(folder(), "snapshot");
  await backup(source, backedUp);
  rmSync(join(target, "master.key"));
  writeFileSync(join(target, "master.key"), `${"z".repeat(43)}\n`);
  const { safety } = await restore(target, backedUp);
  assert.ok(!existsSync(join(target, "hub.db-wal")));
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(readFileSync(join(target, "master.key"), "utf8").trim(), key);
  privateMode(join(target, "hub.db"), 0o600);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), "{}", "o que o backup não tem fica");
  assert.equal(rows(join(safety, "hub.db")), 2, "o que foi substituído é preservado, WAL e tudo");
});

test("uma pasta com um WAL ao lado do banco restaura o que só está no WAL", async () => {
  const source = folder();
  withWal(source);
  const target = folder();
  await restore(target, source);
  assert.equal(rows(join(target, "hub.db")), 2);
});

test("uma restauração que falha no meio põe tudo de volta, o WAL junto com o banco", async () => {
  const target = folder();
  withWal(target);
  writeFileSync(join(target, "config.json"), "mine");
  const source = folder();
  withWal(source);
  mkdirSync(join(source, "config.json"));
  await assert.rejects(restore(target, source));
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), "mine");
  assert.deepEqual(
    readdirSync(target).filter((name) => name.startsWith("restore-before-")),
    [],
  );
});

test("uma restauração recusa um backup cuja chave ou banco está quebrado", async () => {
  const brokenKey = folder();
  withWal(brokenKey);
  writeFileSync(join(brokenKey, "master.key"), "short");
  const target = folder();
  await assert.rejects(restore(target, brokenKey), /master\.key do backup está corrompido/);

  const brokenDatabase = folder();
  writeFileSync(join(brokenDatabase, "hub.db"), "this isn't a database, not even close to one".repeat(100));
  writeFileSync(join(brokenDatabase, "master.key"), key);
  await assert.rejects(restore(target, brokenDatabase), /Não foi possível ler o hub\.db/);
  assert.deepEqual(readdirSync(target), [], "nada foi tocado");
});

test("uma restauração recusa enquanto qualquer coisa tem o banco aberto, e só então", async () => {
  const good = folder();
  withWal(good);
  await assert.rejects(restore(home, good), /A central ainda está em execução/, "uma central neste processo");

  const target = folder();
  withWal(target);
  const holder = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(join(target, "hub.db"))});
       db.exec("PRAGMA journal_mode=WAL; INSERT INTO facts VALUES (3);");
       console.log("open");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(holder.stdout, "data");
  try {
    // Outro processo, ocioso entre requisições, que não deixou número em lugar nenhum: é assim que uma central embutida em outra coisa parece.
    await assert.rejects(restore(target, good), /A central ainda está em execução/);
    assert.equal(rows(join(target, "hub.db")), 3, "nada foi tocado");
  } finally {
    holder.kill("SIGKILL");
    await once(holder, "exit");
  }
  // Morto, ele não segura mais nada, e o que escreveu ainda está lá para a cópia que é preservada.
  const { safety } = await restore(target, good);
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(rows(join(safety, "hub.db")), 3);
});

test("um banco quebrado demais para ser lido não interrompe a restauração que o substituiria", async () => {
  const good = folder();
  withWal(good);
  const target = folder();
  writeFileSync(join(target, "hub.db"), "this isn't a database, not even close to one".repeat(100));
  await restore(target, good);
  assert.equal(rows(join(target, "hub.db")), 2);
});

test("os comandos gravam onde lhes é dito e perguntam antes de substituir qualquer coisa", async () => {
  const machine = folder();
  await restore(machine, await backupOfHub());
  const cli = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: machine } },
    );
  const target = join(folder(), "snapshot");
  assert.match((await cli("backup", target)).stdout, /Backup concluído/);
  assert.ok(existsSync(join(target, "hub.db")));
  await assert.rejects(cli("backup", target), /não está vazio/);
  await assert.rejects(cli("backup", "--wat"), /Parâmetro não reconhecido/);

  await assert.rejects(cli("restore", target), /--yes/);
  await assert.rejects(cli("restore"), /Uso/);
  assert.match((await cli("restore", target, "--yes")).stdout, /Restauração concluída/);
});

async function backupOfHub() {
  const target = join(folder(), "snapshot");
  await backup(home, target);
  return target;
}
