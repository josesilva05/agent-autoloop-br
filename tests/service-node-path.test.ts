// O plist do launchd nomeia um node absoluto. Uma versão do Homebrew vive sob `Cellar`, e esse diretório é apagado na
// atualização seguinte, então um serviço iniciado a partir dele morre ali; o link `opt` ao lado acompanha a atualização.
// O que se confere aqui é o plist para o node que realmente executa estes testes: num node do Homebrew ele deve nomear
// o caminho `opt`, e em qualquer outro node o caminho que ele realmente tem.
// Modos de falha: o caminho do Cellar é escrito como está; um link `opt` que aponta para outro lugar é tomado por este
// node; o PATH mantém o diretório do Cellar enquanto o programa usa `opt`, e aí um plugin encontra um node diferente.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { plist } from "../host/service.ts";

const homebrew = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/.exec(process.execPath);
const stable = homebrew ? `${homebrew[1]}/opt/${homebrew[2]}/bin/${homebrew[3]}` : null;

test("o plist nomeia o caminho estável deste node, não o caminho da versão dele", () => {
  const value = plist();
  const named = /<key>ProgramArguments<\/key><array><string>([^<]+)<\/string>/.exec(value)![1];
  const searchPath = /<key>PATH<\/key><string>([^<]+)<\/string>/.exec(value)![1];
  if (stable) {
    assert.equal(named, stable, "um caminho de versão quebraria na próxima atualização");
    assert.equal(
      searchPath.split(":")[0],
      dirname(stable),
      "o PATH começa onde o programa está, senão um plugin encontra outro node",
    );
    assert.equal(realpathSync(named!), process.execPath);
  } else {
    assert.equal(named, process.execPath, "um node fora do Homebrew é nomeado como está");
  }
});
