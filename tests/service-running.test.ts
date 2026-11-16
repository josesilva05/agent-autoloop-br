// Qual serviço executa isto numa máquina. Casos de falha: o doctor diz que um serviço rodando a partir de uma unit em
// nível de sistema não está em execução; uma atualização toma aquela unit como sua, escreve uma em nível de usuário ao
// lado dela e falha onde não há gerenciador de usuário, ou inicia uma segunda central onde há; um serviço em nível de
// usuário não é reiniciado por uma atualização; pergunta-se a um Mac sobre systemd; um serviço recém-iniciado é dado
// como pronto antes de a sua central responder, e então o comando seguinte não encontra nada ali.
// O systemctl falso representa os dois gerenciadores, e nenhum teste instala nada real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("service-running");
const person = join(home, "person");
const fakes = join(home, "fakes");
const calls = join(home, "calls");
mkdirSync(person);
mkdirSync(fakes);
process.env.HOME = person;
process.env.PATH = `${fakes}:${process.env.PATH}`;
const actual = process.platform;
const onLinux = () => Object.defineProperty(process, "platform", { value: "linux" });
onLinux();
const { restartService, serviceRunning, systemUnit, untilAnswering } = await import("../host/service.ts");

/** `system` e `user` são as units em execução; sem um gerenciador de usuário toda chamada --user falha, como falha para o root. */
function systemctl({ system = false, user = false, manager = true }) {
  rmSync(calls, { force: true });
  writeFileSync(
    join(fakes, "systemctl"),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "is-active "*) exit ${system ? 0 : 3} ;;
  "--user is-active") ${user ? "echo active; exit 0" : "echo inactive; exit 3"} ;;
  --user*) exit ${manager ? 0 : 1} ;;
esac
`,
  );
  chmodSync(join(fakes, "systemctl"), 0o755);
}
const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const userUnits = join(person, ".config", "systemd", "user");

test("uma unit em nível de sistema rodando conta como o que está em execução, e não é tomada por um serviço nosso", () => {
  systemctl({ system: true, manager: false });
  assert.equal(serviceRunning(), false);
  assert.match(systemUnit()!, /^agent-autoloop/);
});

test("uma atualização deixa uma unit em nível de sistema para o dono dela, e diz como reiniciá-la", () => {
  systemctl({ system: true, manager: false });
  const said = restartService()!;
  assert.match(said, /systemctl restart agent-autoloop/);
  assert.ok(!called().some((call) => call.includes("daemon-reload") || call.includes("enable")));
  assert.equal(existsSync(userUnits), false, "nenhuma segunda unit ao lado dela");
});

test("uma atualização reinicia um serviço em nível de usuário como antes", () => {
  systemctl({ user: true });
  assert.equal(restartService(), undefined);
  assert.ok(called().includes("--user daemon-reload"));
  assert.ok(called().some((call) => call.startsWith("--user restart ")));
  rmSync(userUnits, { recursive: true, force: true });
});

test("um serviço recém-iniciado é esperado até sua central responder; um que o gerenciador não tem, não", async () => {
  systemctl({ user: true });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const url = `http://127.0.0.1:${port}`;
  const hub = createServer((_, response) => response.end("{}"));
  const starting = setTimeout(() => hub.listen(port, "127.0.0.1"), 300);
  try {
    assert.equal(await untilAnswering(url), true);
  } finally {
    clearTimeout(starting);
    hub.close();
  }
  assert.equal(await untilAnswering(url, 300), false, "de um que nunca responde se desiste, e isso é dito");
  systemctl({});
  const asked = Date.now();
  assert.equal(await untilAnswering(url), null, "nada para esperar");
  assert.ok(Date.now() - asked < 2_000);
});

test("sem serviço nenhum, uma atualização não inicia nenhum e não diz nada", () => {
  systemctl({});
  assert.equal(restartService(), undefined);
  assert.equal(existsSync(userUnits), false);
});

test("não se pergunta a um Mac sobre systemd", { skip: actual !== "darwin" }, () => {
  systemctl({ system: true });
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    assert.equal(systemUnit(), null);
    assert.deepEqual(called(), []);
  } finally {
    onLinux();
  }
});

test("o doctor diz que uma unit em nível de sistema está em execução", () => {
  systemctl({ system: true, manager: false });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:9", worker: { name: "w", key: "k" } }),
  );
  const onLinuxFirst = `data:text/javascript,Object.defineProperty(process,"platform",{value:"linux"})`;
  const doctor = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      onLinuxFirst,
      join(import.meta.dirname, "..", "bin", "agent-autoloop.ts"),
      "doctor",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.match(doctor.stdout, /● Serviço em nível de sistema em execução/);
  assert.doesNotMatch(doctor.stdout, /O serviço do sistema não está em execução/);
});
