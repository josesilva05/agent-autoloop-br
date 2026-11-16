// Modos de falha: um titular cujo shell de login não é POSIX (fish) não consegue iniciar nenhum Agent porque o comando do
// worker para aquele shell não é entendido ali, ou fazê-lo ser entendido deixa o caminho de instalação ou um argumento rodar como código de shell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-login-shell-"));
const home = join(scratch, "quote' $(touch path-injected)");
const project = join(scratch, "project");
mkdirSync(project);
process.env.AGENT_AUTOLOOP_HOME = home;
// Um fish de verdade leria a configuração do seu titular caso contrário.
process.env.HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

// O CI não tem fish, então isto mantém as duas coisas dele que importam: sem $0 nem $@, e nenhum argumento chega ao comando.
const standIn = join(scratch, "not-posix-shell");
writeFileSync(
  standIn,
  `#!/bin/sh
case "$2" in
  *'$0'* | *'$@'*) echo 'not-posix-shell: $@ is not supported' >&2; exit 127 ;;
esac
exec /bin/sh -c "$2"
`,
  { mode: 0o755 },
);
const fish = spawnSync("/bin/sh", ["-c", "command -v fish"], { encoding: "utf8" }).stdout.trim();

const argument = `copo d'água \\ "citado" $HOME $(touch argv-injected)\nsegunda linha`;
const waiting: any[] = [];
const results = new Map<number, any>();
const worker = createWorker({
  name: "test",
  wait: 0,
  hub: {
    work: async () => ({ job: waiting.shift() ?? null, cancel: [] }),
    started: async () => ({}),
    result: async (run: number, _token: string, body: unknown) => {
      results.set(run, body);
      return {};
    },
  } as any,
});

async function runUnder(shell: string, run: number) {
  process.env.SHELL = shell;
  waiting.push({
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "login shell", cwd: project, prompt: "Leia a entrada." },
    agent: { id: "a", name: "Agent", use: "command", access: "edit", command: ["/usr/bin/printf", "%s", argument] },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  });
  for (let i = 0; i < 250 && !results.has(run); i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.get(run)?.error, undefined);
  assert.equal(results.get(run)?.outcome, "done");
  assert.equal(readFileSync(join(home, "worker", "runs", `${run}-1`, "stdout-1.log"), "utf8"), argument);
  assert.ok(!existsSync(join(project, "path-injected")), "o caminho de instalação executou um comando");
  assert.ok(!existsSync(join(project, "argv-injected")), "um argumento executou um comando");
}

test("um Agent inicia sob um shell de login sem sintaxe POSIX", () => runUnder(standIn, 1));

test("um Agent inicia sob um fish de verdade", { skip: !fish && "o fish não está instalado" }, () => runUnder(fish, 2));
