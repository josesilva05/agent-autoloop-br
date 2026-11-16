// O que esta máquina é dentro do sistema: config.json, privado para o seu titular. Numa máquina que roda tudo ele tem
// todos estes campos; uma máquina que só executa trabalho tem o endereço da central e a chave de um worker.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { privateDirectory } from "./files.ts";

export type ChannelConfig = { use?: string; key: string; [option: string]: unknown };
export type Config = {
  url: string;
  hub?: { listen: string; publicUrl?: string };
  worker?: { name: string; key: string; capacity?: number; unreachable?: string[] };
  channels?: Record<string, ChannelConfig>;
  source?: { name: string; key: string };
  owner?: string;
};

export const CONFIG_FILE = path.join(HOME, "config.json");

/** O endereço da central: host:porta, ou [host]:porta para um endereço IPv6. Só uma porta é um erro, não "todas as interfaces". */
export function parseListen(listen: string) {
  const match = /^\[([0-9a-fA-F:.]+)\]:([0-9]+)$/.exec(listen) ?? /^([^:\s]+):([0-9]+)$/.exec(listen);
  if (!match) throw new Error(`hub.listen deve ser escrito como host:porta ([endereço]:porta para IPv6): ${listen}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`a porta em hub.listen deve estar entre 1 e 65535: ${listen}`);
  }
  return { host: match[1], port };
}

/** O que `up` diz quando não consegue ocupar a sua porta. */
export function cantListen(error: NodeJS.ErrnoException, platform = process.platform) {
  const said = `não foi possível escutar: ${error}`;
  if (platform !== "win32" || error.code !== "EACCES") return said;
  return (
    `${said}. Esta porta pode estar na faixa reservada pelo sistema no Windows (Hyper-V e WSL costumam ocupar um trecho, que ainda muda depois de reiniciar); ` +
    "rode netsh int ipv4 show excludedportrange protocol=tcp para conferir; " +
    `use uma porta fora dessa faixa: altere url e hub.listen em ${CONFIG_FILE} (e também hub.publicUrl, quando for um endereço local) e reinicie a central`
  );
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) throw new Error("ainda não está instalado: rode antes agent-autoloop init");
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

export function writeConfig(config: Config) {
  privateDirectory(HOME);
  writeFileSync(`${CONFIG_FILE}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}
