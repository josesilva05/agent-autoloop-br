// Modos de falha: o systemd divide um caminho de instalação nos espaços, expande seus `$` ou `%`, ou carrega um caminho
// diferente depois que aspas e barras invertidas são interpretadas; um caractere de controle escreve outra diretiva no
// serviço gerado.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit } from "../host/service.ts";

const ordinary = {
  home: "/home/me/.agent-autoloop",
  executable: "/usr/bin/node",
  program: "/opt/agent-autoloop/bin/agent-autoloop.ts",
};

test("um serviço systemd mantém sua estrutura existente e o uso sem argumentos", () => {
  const service = unit(ordinary);
  assert.ok(service.includes("Description=Central de automação de Agents"));
  assert.ok(service.includes('Environment="AGENT_AUTOLOOP_HOME=/home/me/.agent-autoloop"'));
  assert.ok(
    service.includes(
      'ExecStart="/usr/bin/node" "--disable-warning=ExperimentalWarning" "/opt/agent-autoloop/bin/agent-autoloop.ts" "up"',
    ),
  );
  assert.ok(service.includes("Restart=always\nRestartSec=10"));
  assert.ok(service.includes("WantedBy=default.target"));
  assert.doesNotThrow(() => unit());
});

test("o systemd recebe espaços e caracteres especiais de caminho literalmente", () => {
  const service = unit({
    home: String.raw`/home/usuário/Agent Work/$cache%/say"hi"/back\slash`,
    executable: String.raw`/opt/Node $cache%/say"hi"/node`,
    program: String.raw`/opt/Agent Work/$repo%/back\slash/agent.ts`,
  });
  assert.ok(
    service.includes(
      String.raw`Environment="AGENT_AUTOLOOP_HOME=/home/usuário/Agent Work/$cache%%/say\"hi\"/back\\slash"`,
    ),
  );
  assert.ok(
    service.includes(
      String.raw`ExecStart="/opt/Node $$cache%%/say\"hi\"/node" "--disable-warning=ExperimentalWarning" "/opt/Agent Work/$$repo%%/back\\slash/agent.ts" "up"`,
    ),
  );
});

test("valores de serviço do systemd rejeitam caracteres de controle", () => {
  for (const control of ["\0", "\t", "\n", "\r", "\u007f"]) {
    assert.throws(() => unit({ ...ordinary, home: `/home/me/before${control}after` }), /caracteres de controle/);
  }
});
