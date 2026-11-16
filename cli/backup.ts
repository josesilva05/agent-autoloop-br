// `backup` e `restore`: o banco de dados, a chave que assina os links dos cartões e os ficheiros que dizem o que esta
// máquina é. O backup é feito com a central em execução; a restauração precisa dela parada, porque substitui o ficheiro
// que está aberto.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { backup as copyPages, DatabaseSync } from "node:sqlite";
import { privateDirectory } from "../host/files.ts";

const DB = "hub.db";
const KEY = "master.key";
const FILES = [KEY, "config.json", "rules.json", "secrets.env"];
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Uma cópia de um banco de dados que pode estar em uso, feita num único instante e com o WAL incluído. Copia páginas porque
 * o VACUUM INTO reconstrói os índices, e as funções de chamada do banco só existem na central.
 */
async function copyDatabase(from: string, to: string) {
  const source = new DatabaseSync(from);
  try {
    await copyPages(source, to);
  } finally {
    source.close();
  }
  chmodSync(to, 0o600);
}

/** Grava uma pasta de backup que ainda não existe: primeiro o banco de dados, depois os ficheiros que estiverem lá. */
export async function backup(home: string, target: string) {
  const database = path.join(home, DB);
  if (!existsSync(database)) throw new Error("ainda não está instalado: rode antes agent-autoloop init");
  if (existsSync(target) && readdirSync(target).length)
    throw new Error(`O diretório de backup não está vazio: ${target}`);
  privateDirectory(target);
  await copyDatabase(database, path.join(target, DB));
  const files = [DB];
  for (const name of FILES) {
    const from = path.join(home, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, path.join(target, name));
    chmodSync(path.join(target, name), 0o600);
    files.push(name);
  }
  return { target, files };
}

function readableBackup(source: string) {
  const database = path.join(source, DB);
  const key = path.join(source, KEY);
  if (!existsSync(database) || !existsSync(key))
    throw new Error(`Este diretório não parece um backup: falta ${DB} ou ${KEY}`);
  if (!KEY_SHAPE.test(readFileSync(key, "utf8").trim())) throw new Error("O master.key do backup está corrompido");
  let result: unknown;
  try {
    const check = new DatabaseSync(database);
    try {
      // Não é integrity_check: este também avalia os índices e, por isso, precisa das funções da central.
      result = Object.values(check.prepare("PRAGMA quick_check").get() ?? {})[0];
    } finally {
      check.close();
    }
  } catch {}
  if (result !== "ok") throw new Error("Não foi possível ler o hub.db do backup");
}

/** Se algo tem o banco de dados aberto, incluindo uma central entre requisições: só então este lock fica fora de alcance. */
function inUse(database: string) {
  if (!existsSync(database)) return false;
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    return false;
  } catch (error) {
    // Um que não dá para ler de jeito nenhum não está em uso: pode ser exatamente por isso que está sendo restaurado.
    return /locked/.test(String(error));
  } finally {
    db.close();
  }
}

/** Coloca um backup de volta no lugar, preservando o que ele substituiu. */
export async function restore(home: string, source: string) {
  if (inUse(path.join(home, DB))) {
    throw new Error(
      "A central ainda está em execução: pare-a primeiro (por exemplo, agent-autoloop service remove, ou pare o serviço manualmente) e então restaure",
    );
  }
  readableBackup(source);
  privateDirectory(home);
  const safety = path.join(home, `restore-before-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(safety, { mode: 0o700 });
  // O WAL pertence ao ficheiro que está saindo: um WAL antigo ao lado do banco restaurado seria aplicado a ele. Um ficheiro
  // que o backup não tem fica como está.
  const replaced = [DB, `${DB}-wal`, `${DB}-shm`, ...FILES.filter((name) => existsSync(path.join(source, name)))];
  for (const name of replaced) {
    const from = path.join(home, name);
    if (existsSync(from)) renameSync(from, path.join(safety, name));
  }
  try {
    await copyDatabase(path.join(source, DB), path.join(home, DB));
    for (const name of replaced.filter((name) => FILES.includes(name))) {
      copyFileSync(path.join(source, name), path.join(home, name));
      chmodSync(path.join(home, name), 0o600);
    }
  } catch (error) {
    // Meia restauração é pior que nenhuma: tudo volta ao que era, o WAL junto com o seu banco.
    for (const name of replaced) {
      rmSync(path.join(home, name), { force: true });
      if (existsSync(path.join(safety, name))) renameSync(path.join(safety, name), path.join(home, name));
    }
    rmSync(safety, { recursive: true });
    throw error;
  }
  return { safety };
}
