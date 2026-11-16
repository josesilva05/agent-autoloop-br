// O que difere no ZCode. Casos de falha: um nível de acesso mapeia para o modo de permissão errado, ou um prompt roda em
// yolo quando a regra pediu read/edit; uma rodada continuada abre uma sessão nova em vez de seguir; o JSON final é lido
// linha a linha (ele é um objeto só, formatado) ou um aviso antes dele esconde a resposta; uma rodada ainda em andamento
// é tomada por resposta ou por falha, ou uma saída cortada no meio do objeto trava o worker que a lê; uma sessão
// continuada desconhecida é tentada de novo nessa mesma sessão para sempre em vez de abrir uma nova; uma execução que
// saiu sem JSON é tomada por sucesso; os tokens do provedor são descartados; um bundle .cjs do Windows é rodado como se a
// plataforma conseguisse executá-lo; o check de versão passa quando o programa está ausente.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Adapter = import("../worker/agents.ts").Adapter;
const zcode: Adapter = (await import("../plugins/zcode/agent.ts")).default;
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-zcode-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const turn = {
  prompt: "faça isso",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};
const withProgram = (over: object = {}) => zcode.command({ ...turn, program: "/test/zcode", ...over });

test("ZCode: acesso é o modo dele próprio, e uma rodada continuada segue na sessão", () => {
  assert.deepEqual(withProgram(), [
    "/test/zcode",
    "--mode",
    "edit",
    "--surface",
    "terminal",
    "--no-color",
    "--json",
    "-p",
    "faça isso",
  ]);
  assert.equal(withProgram({ access: "read" })[2], "plan");
  assert.equal(withProgram({ access: "full" })[2], "yolo");
  assert.deepEqual(withProgram({ resume: "sess_1" }).slice(-4), ["--resume", "sess_1", "-p", "faça isso"]);
  assert.ok(!withProgram().includes("--resume"), "uma sessão nova não recebe id: o ZCode cria o seu e o reporta");
  assert.ok(
    !withProgram({ model: "m", effort: "high" }).includes("m"),
    "o ZCode tira modelo e esforço das próprias configurações",
  );
});

test("ZCode: um bundle .cjs é iniciado pelo node, não executado como se a plataforma conseguisse", () => {
  assert.deepEqual(zcode.command({ ...turn, program: "/opt/zcode.cjs" }).slice(0, 2), [
    process.execPath,
    "/opt/zcode.cjs",
  ]);
});

const answer = (over: object = {}) =>
  JSON.stringify(
    {
      sessionId: "sess_1",
      traceId: "trace-1",
      turnId: "turn-1",
      response: "pronto",
      usage: {
        source: "provider",
        modelRequestCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
        reasoningTokens: 0,
        webFetchRequests: 0,
        webSearchRequests: 0,
      },
      ...over,
    },
    null,
    2,
  );

test("ZCode: o response do JSON final é a resposta, com a sessão e os tokens do provedor", () => {
  assert.deepEqual(zcode.read(answer(), 0, ""), {
    text: "pronto",
    session: "sess_1",
    usage: { input: 10, output: 2, cached: 5 },
    started: true,
    finished: true,
  });
  // Um aviso impresso antes do objeto não pode escondê-lo.
  assert.equal(zcode.read(`warning: provider said something\n${answer()}`, 0, "").text, "pronto");
});

test("ZCode: ainda em andamento não é resposta nem falha, e conta como iniciado", () => {
  assert.deepEqual(zcode.read("", null, ""), { started: true });
  assert.deepEqual(zcode.read('{"sessionId":"sess_1"', null, ""), { started: true });
  // Cortado depois de uma chave dentro da resposta: nenhum objeto ainda, e a leitura precisa retornar.
  assert.deepEqual(zcode.read('{"sessionId":"sess_1","response":"escrevendo com {x}', null, ""), { started: true });
});

test("ZCode: uma sessão continuada desconhecida pode abrir uma nova; outra falha fica nesta", () => {
  const missing = zcode.read("", 1, "Error: Session not found: sess_0 (traceId: x)\nstack");
  assert.equal(missing.started, false);
  assert.match(missing.error!, /Session not found/);
  assert.deepEqual(zcode.read("", 1, "boom"), { started: true, error: "boom" });
  assert.deepEqual(zcode.read("", 0, ""), { started: true, error: "o ZCode não concluiu nem deixou um resultado" });
});

test("ZCode: uma execução concluída sem response não é um resultado", () => {
  const reading = zcode.read(answer({ response: "  " }), 0, "");
  assert.equal(reading.text, undefined);
  assert.equal(reading.started, true);
  assert.equal(reading.error, "o ZCode não concluiu nem deixou um resultado");
});

test("ZCode: o check roda version, e diz o que fazer quando o programa está ausente", () => {
  const fake = join(scratch, "zcode.cjs");
  writeFileSync(fake, 'if (process.argv[2] === "version") console.log("0.17.1"); else process.exit(1);');
  assert.equal(zcode.check!(fake), null);
  assert.match(zcode.check!(join(scratch, "missing.cjs"))!, /^ZCode não está utilizável: /);
});
