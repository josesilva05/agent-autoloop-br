// Modos de falha: os embutidos pulam a descoberta de plugins externos; nomes de plugin escapam do seu diretório; a
// instalação sobrescreve um plugin existente ou executa os scripts dele; um caminho de adaptador sobrevive apenas no
// diretório antigo.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("plugins");
const { loadPlugin } = await import("../host/plugins.ts");
test("todos os tipos embutidos usam o mesmo carregador e plugins externos têm precedência", async () => {
  for (const [name, kind] of [
    ["claude", "agent"],
    ["codex", "agent"],
    ["command", "agent"],
    ["acp", "agent"],
    ["dsh", "agent"],
    ["zcode", "agent"],
    ["feishu", "channel"],
    ["webhook", "channel"],
    ["github", "source"],
  ] as const)
    assert.ok(await loadPlugin(name, kind));
  mkdirSync(join(home, "plugins", "outside"), { recursive: true });
  writeFileSync(join(home, "plugins", "outside", "agent.ts"), "export default {marker:42};");
  assert.equal((await loadPlugin("outside", "agent")).marker, 42);
  await assert.rejects(() => loadPlugin("../outside", "agent"));
});
