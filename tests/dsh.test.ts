// O que difere no DSH. Casos de falha: um nível de acesso mapeia para o preset de permissão errado, ou uma rodada
// continuada mantém aquele com que a sessão foi salva; uma chamada que precisa de aprovação espera por alguém que não
// está lá; uma rodada continuada abre uma sessão nova; uma execução ainda em andamento, ou cuja rodada terminou enquanto
// o trabalho em segundo plano acaba, é tomada por resposta ou por falha, e interrompida; uma execução que terminou em
// erro ou sem resposta é tomada por resultado; as contagens de tokens dos vários passos de uma execução são descartadas,
// ou o input deixa de fora as leituras e gravações do cache; um programa ausente, quebrado ou antigo demais para aceitar
// estas opções passa por utilizável, ou um erro que ele só consegue reportar no stdout se perde. Os eventos são as formas
// dos próprios packages/bundle/headless/src/json-stream.ts e startup.ts do DSH; o programa real dele não foi executado
// aqui. O programa é buscado pelo shell de login, então isto aponta o shell e o HOME para os deste teste, em vez dos que
// esta máquina tiver instalados.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Adapter = import("../worker/agents.ts").Adapter;

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-dsh-"));
const usual = { SHELL: process.env.SHELL, HOME: process.env.HOME };
const program = join(scratch, "dsh");
const shell = join(scratch, "shell");
writeFileSync(
  program,
  `#!/bin/sh
[ "\${DSH_TEST_USABLE:-}" = "" ] && { echo "dsh: cannot run" >&2; exit 1; }
[ "$1 $2" = "headless --help" ] || { echo "dsh: unexpected $*" >&2; exit 1; }
echo "  --json"
[ "\${DSH_TEST_USABLE:-}" = old ] || echo "  --approval-policy <policy>"
`,
  { mode: 0o755 },
);
// O que um shell de login imprime para `command -v dsh`; um DSH_TEST_PROGRAM vazio faz as vezes de dsh ausente.
writeFileSync(shell, '#!/bin/sh\nprintf "%s\\n" "$DSH_TEST_PROGRAM"\n', { mode: 0o755 });
process.env.SHELL = shell;
process.env.HOME = scratch;
process.env.DSH_TEST_PROGRAM = program;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [name, value] of Object.entries(usual)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.DSH_TEST_PROGRAM;
});
const dsh: Adapter = (await import("../plugins/dsh/agent.ts")).default;
const check = dsh.check!;

const turn = {
  prompt: "faça isso",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};

test("DSH: acesso é o preset de permissão toda vez, nada espera aprovação, e o resume segue na sessão", () => {
  const policy = ["--approval-policy", "never"];
  const argv = dsh.command(turn);
  assert.deepEqual(argv.slice(0, 3), [program, "headless", "--json"]);
  assert.deepEqual(
    argv.slice(3),
    ["--permission-mode", "workspace-write", ...policy, "faça isso"],
    "uma sessão nova não recebe id: o dsh cria o seu e o reporta",
  );
  for (const [access, preset] of [
    ["read", "read-only"],
    ["edit", "workspace-write"],
    ["full", "danger-full-access"],
  ] as const) {
    assert.deepEqual(dsh.command({ ...turn, access }).slice(3, 5), ["--permission-mode", preset]);
  }
  const again = dsh.command({ ...turn, access: "read", resume: "session-1" });
  assert.deepEqual(again.slice(3), [
    "--permission-mode",
    "read-only",
    ...policy,
    "--session-id",
    "session-1",
    "faça isso",
  ]);
});

const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const opened = { type: "session", sessionId: "session-1", cwd: "/x" };
const step = (usage: object) => ({ type: "status", phase: "step_end", usage });
const turnEnded = (reason: object) => ({ type: "status", phase: "turn_end", turn: 1, reason });
const final = (text: string, reason: object | null) => ({ type: "final", sessionId: "session-1", reason, text });
const completed = { kind: "completed" };

test("DSH: o texto final de uma rodada concluída é a resposta, com os tokens de cada passo somados", () => {
  const reading = dsh.read(
    lines(
      opened,
      { type: "thinking", text: "pensando" },
      { type: "status", phase: "step_start" },
      step({ inputTokens: 7500, outputTokens: 2, cacheReadTokens: 5120, cacheWriteTokens: 0, totalTokens: 12622 }),
      { type: "text", text: "parcial" },
      { type: "tool_call", callId: "1", tool: "read", input: {} },
      { type: "tool_result", callId: "1", status: "completed", result: "dados" },
      step({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 1 }),
      turnEnded(completed),
      final("pronto", completed),
    ),
    0,
    "",
  );
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 12631, output: 6, cached: 5121 },
    started: true,
    finished: true,
    text: "pronto",
  });
});

test("DSH: uma rodada ainda em andamento não tem resposta nem erro", () => {
  const reading = dsh.read(
    lines(opened, step({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 2 }), { type: "text", text: "parcial" }),
    null,
    "",
  );
  assert.equal(reading.text, undefined, "o que ele disse até aqui não é a resposta");
  assert.equal(reading.error, undefined, "ainda em andamento não é falha");
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 9, output: 1, cached: 2 },
    started: true,
  });
  // Uma rodada terminou, mas a execução espera o trabalho em segundo plano, que pode iniciar outra: só acaba no `final`.
  assert.deepEqual(dsh.read(lines(opened, turnEnded(completed), { type: "text", text: "parcial" }), null, ""), {
    session: "session-1",
    started: true,
  });
  // `final` sem reason: a última rodada nunca fechou.
  const unclosed = dsh.read(lines(opened, final("pronto", null)), 1, "");
  assert.equal(unclosed.text, undefined);
  assert.equal(unclosed.error, "o DSH não terminou esta rodada");
});

test("DSH: o motivo de a rodada ter terminado é o motivo da falha", () => {
  for (const [reason, error] of [
    [{ kind: "error", error: { message: "a cota acabou" } }, "a cota acabou"],
    [{ kind: "error" }, "o DSH não terminou esta rodada"],
    [{ kind: "aborted" }, "esta rodada foi abortada"],
    [{ kind: "blocked" }, "esta rodada travou e não concluiu"],
    [{ kind: "max-tokens" }, "esta rodada esgotou o limite de saída"],
    [{ kind: "interrupted" }, "o DSH não terminou esta rodada"],
  ] as const) {
    assert.deepEqual(dsh.read(lines(opened, turnEnded(reason), final("pronto", reason)), 1, ""), {
      session: "session-1",
      started: true,
      finished: true,
      error,
    });
  }
  const empty = dsh.read(lines(opened, final("  ", completed)), 0, "");
  assert.equal(empty.finished, true);
  assert.equal(empty.text, undefined, "uma mensagem em branco não é resposta");
  assert.equal(empty.error, "o DSH não concluiu nem deixou um resultado");
});

test("DSH: uma execução que terminou sem evento final recorre à saída do processo", () => {
  assert.equal(dsh.read("", 3, "cannot start").error, "código de saída 3: cannot start");
  assert.equal(dsh.read("", 3, "").error, "código de saída 3: não deixou motivo");
  assert.equal(dsh.read("", 0, "boom").error, "boom");
  assert.equal(dsh.read("", 0, "").error, "o DSH não concluiu nem deixou um resultado");
  assert.deepEqual(dsh.read("", null, "still starting"), {}, "rodando, então nada a reportar ainda");
});

test("DSH: um erro reportado só no stdout é o motivo que ele dá", () => {
  const refused = JSON.stringify({ type: "error", message: "unknown option '--permission-mode'" });
  assert.equal(dsh.read(refused, 1, "").error, "código de saída 1: unknown option '--permission-mode'");
});

test("DSH: uma linha de saída que é JSON mas não é evento é ruído", () => {
  const noise = 'null\n42\n"words"\n[]\n';
  assert.doesNotThrow(() => dsh.read(noise, null, ""));
  assert.doesNotThrow(() => dsh.read(noise, 0, ""));
});

test("DSH: o check passa quando o programa roda, e diz o que fazer quando não roda", () => {
  assert.match(check()!, /^DSH não está utilizável: rode dsh headless "hi" para ver \(/);
  process.env.DSH_TEST_USABLE = "old";
  try {
    assert.match(check()!, /antiga demais/);
    process.env.DSH_TEST_USABLE = "1";
    assert.equal(check(), null);
  } finally {
    delete process.env.DSH_TEST_USABLE;
  }
});

test("DSH: o check diz o que fazer quando o dsh não está instalado", () => {
  const empty = join(scratch, "empty");
  const script = `const { default: dsh } = await import(${JSON.stringify(
    new URL("../plugins/dsh/agent.ts", import.meta.url).href,
  )}); process.stdout.write(String(dsh.check()));`;
  // Um processo separado: o programa é buscado uma vez por processo, e este já encontrou o stub.
  const checked = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      env: { ...process.env, HOME: empty, DSH_TEST_PROGRAM: "" },
      encoding: "utf8",
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /^DSH não está utilizável: .*dsh/);
});
