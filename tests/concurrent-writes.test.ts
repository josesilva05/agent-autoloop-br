// Modos de falha: um comando que escreve no banco (`key new`) enquanto a central escreve falha com "o log mudou", ou faz
// uma das escritas da própria central falhar, o que num temporizador derrubaria a central.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("concurrent-writes");
const hub = await import("./hub.ts");

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
hub.addKey("source", "app");

function keyNew(name: string) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "key", "new", "source", name], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  return new Promise<string>((resolve) => child.on("exit", (code) => resolve(code ? said : "")));
}

test("comandos e a central podem escrever ao mesmo tempo", async () => {
  let running = true;
  const failures: string[] = [];
  const commands = Promise.all(Array.from({ length: 12 }, (_, i) => keyNew(`from-command-${i}`))).finally(() => {
    running = false;
  });
  let written = 0;
  while (running) {
    try {
      hub.ingest("app", { id: `event-${written++}`, type: "other.thing" });
    } catch (error) {
      failures.push(String(error));
    }
    // Não sem pausa: nenhuma central real escreve sem intervalo, e num disco lento isso mata de fome um comando em espera
    // além dos seus 5 segundos.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(failures, [], "as escritas da própria central");
  assert.deepEqual((await commands).filter(Boolean), [], "as escritas dos comandos");
  assert.ok(written > 12, `as escritas se sobrepuseram: ${written}`);
});
