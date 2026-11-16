// A central fica rodando por muito tempo. Atualize o node pelo Homebrew e o diretório `Cellar` de onde este processo
// partiu é apagado enquanto ele continua trabalhando; ACP e entrega iniciam o processo filho de cada rodada com
// `process.execPath`, então daí em diante toda rodada falha com ENOENT até alguém reiniciar o serviço. O que se verifica
// aqui: os filhos recebem o link `opt` ao lado da versão, um diretório de versão que não existe mais ainda resolve por
// esse link, e um node fora do Homebrew é deixado como está.
// Modos de falha: o caminho do Cellar é entregue aos filhos; um caminho de versão apagado é mantido mesmo com o `opt`
// resolvendo; o link `opt` é usado quando não resolve para lugar nenhum.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stablePath } from "../host/node-path.ts";
import acp from "../plugins/acp/agent.ts";
import delivery from "../plugins/delivery/agent.ts";

const scratch = mkdtempSync(join(tmpdir(), "node-path-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Uma árvore no formato do Homebrew: `opt/<formula>` aponta para uma das versões dentro de `Cellar`. */
function brew(formula: string, versions: string[], linked: string) {
  const root = mkdtempSync(join(scratch, `${formula}-`));
  for (const version of versions) {
    const bin = join(root, "Cellar", formula, version, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), "#!/bin/sh\n");
  }
  mkdirSync(join(root, "opt"), { recursive: true });
  symlinkSync(join(root, "Cellar", formula, linked), join(root, "opt", formula));
  return {
    roots: [root],
    bin: (version: string) => join(root, "Cellar", formula, version, "bin", "node"),
    opt: join(root, "opt", formula, "bin", "node"),
  };
}

test("o node em que este processo roda é identificado pelo link opt dele", () => {
  const tree = brew("node", ["26.13.0"], "26.13.0");
  assert.equal(stablePath(tree.bin("26.13.0"), tree.roots), tree.opt);
});

test("um diretório de versão apagado por uma atualização ainda resolve pelo link", () => {
  const tree = brew("node", ["24.1.0", "26.13.0"], "26.13.0");
  const old = tree.bin("24.1.0");
  rmSync(join(tree.roots[0], "Cellar", "node", "24.1.0"), { recursive: true, force: true });
  assert.equal(stablePath(old, tree.roots), tree.opt, "o caminho apagado faria toda rodada falhar");
});

test("uma versão que ainda está instalada é deixada em paz quando o link seguiu adiante", () => {
  const tree = brew("node", ["24.1.0", "26.13.0"], "26.13.0");
  assert.equal(stablePath(tree.bin("24.1.0"), tree.roots), tree.bin("24.1.0"));
});

test("um link que não resolve para lugar nenhum não toma o lugar do node que está rodando", () => {
  const tree = brew("node", ["26.13.0"], "26.13.0");
  rmSync(join(tree.roots[0], "Cellar", "node", "26.13.0"), { recursive: true, force: true });
  assert.equal(stablePath(tree.bin("26.13.0"), tree.roots), tree.bin("26.13.0"));
});

test("um node fora do Homebrew é identificado como é", () => {
  assert.equal(stablePath("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(stablePath("/opt/node/bin/node"), "/opt/node/bin/node");
});

test("ACP e entrega iniciam o filho com esse caminho", () => {
  const turn = {
    prompt: "faça isto",
    session: "s",
    resume: null,
    cwd: "/x",
    access: "edit",
    contextFile: "/c",
    folder: "/f",
  };
  assert.equal(acp.command(turn as never)[0], stablePath(process.execPath));
  assert.equal(delivery.command(turn as never)[0], stablePath(process.execPath));
});
