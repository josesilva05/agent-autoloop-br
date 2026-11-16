// O plist que uma instalação escreve nunca pode continuar gravável por todos: o launchd se recusa a carregar um plist
// que outros podem escrever, e diz apenas "Bootstrap failed: 5: Input/output error". Modos de falha: uma instalação a
// partir de um shell com umask 0 (o de um app gráfico) escreve o plist já gravável por todos e o serviço nunca inicia;
// uma reinstalação posterior reescreve os bytes mas mantém o modo, então a máquina continua quebrada por mais vezes que
// se reinstale.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("service-plist");
const person = join(home, "person");
const fakes = join(home, "fakes");
mkdirSync(person);
mkdirSync(fakes);
process.env.HOME = person;
process.env.PATH = `${fakes}:${process.env.PATH}`;
// `print` diz que nenhum serviço está carregado, então a espera pelo antigo sumir termina de imediato; o resto só tem sucesso.
writeFileSync(
  join(fakes, "launchctl"),
  `#!/bin/sh
[ "$1" = "print" ] && exit 1
exit 0
`,
);
chmodSync(join(fakes, "launchctl"), 0o755);
Object.defineProperty(process, "platform", { value: "darwin" });
const { installService } = await import("../host/service.ts");

const agents = join(person, "Library", "LaunchAgents");

test("um plist que nasce gravável por todos é reparado pela instalação seguinte, não apenas reescrito", () => {
  const umask = process.umask(0o000);
  try {
    installService(); // o incidente: uma instalação cujos arquivos nascem graváveis por todos
  } finally {
    process.umask(umask);
  }
  const [name] = readdirSync(agents);
  assert.match(name!, /^agent-autoloop.*\.plist$/);
  chmodSync(join(agents, name!), 0o666); // o que a instalação quebrada deixou na máquina
  installService(); // uma reinstalação precisa consertar o arquivo, não só o conteúdo dele
  assert.equal(statSync(join(agents, name!)).mode & 0o777, 0o644);
});
