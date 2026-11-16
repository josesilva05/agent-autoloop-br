// Encontrar o Claude Code que o aplicativo desktop distribui. Caso de falha: o aplicativo guarda arquivos como
// auto-update-state.json ao lado das pastas de versão, e ler um deles como pasta lança ENOTDIR, então toda rodada do
// Claude falha em vez de usar a cópia que está lá.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const { inTheApp } = await import("../plugins/claude/agent.ts");

test("os arquivos do próprio aplicativo ao lado das versões são pulados", () => {
  const home = setup("claude-app");
  const root = join(home, "Library/Application Support/Claude/claude-code");
  mkdirSync(join(root, "2.1.309", "build-a"), { recursive: true });
  mkdirSync(join(root, "2.1.317", "build-b"), { recursive: true });
  writeFileSync(join(root, "auto-update-state.json"), "{}");
  writeFileSync(join(root, "auto-update-candidate.json"), "{}");
  const usual = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.deepEqual(inTheApp(), [
      join(root, "2.1.317", "build-b", "claude.app/Contents/MacOS/claude"),
      join(root, "2.1.309", "build-a", "claude.app/Contents/MacOS/claude"),
    ]);
  } finally {
    process.env.HOME = usual;
  }
});
