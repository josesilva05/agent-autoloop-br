// Linhas como ACP, MCP e lark-cli as delimitam. Modos de falha: uma linha é cortada em U+2028 ou U+2029, que o JSON
// deixa como estão dentro de uma string; um caractere que duas leituras dividem sai embaralhado; uma linha dividida por
// duas leituras sai como duas; uma última linha sem quebra de linha se perde; o fim não é avisado, ou é avisado antes da
// última linha.
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { eachLine } from "../host/lines.ts";

async function read(...chunks: Buffer[]) {
  const input = new PassThrough();
  const seen: string[] = [];
  eachLine(
    input,
    (line) => seen.push(line),
    () => seen.push("<end>"),
  );
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await once(input, "close");
  return seen;
}

test("só uma quebra de linha encerra uma linha", async () => {
  const text = '{"text":"primeira linha segunda linha terceira linha\r"}\n\n{"a":1}\n';
  assert.deepEqual(await read(Buffer.from(text)), [
    '{"text":"primeira linha segunda linha terceira linha\r"}',
    "",
    '{"a":1}',
    "<end>",
  ]);
});

test("uma linha e um caractere que as leituras dividem voltam inteiros", async () => {
  const bytes = Buffer.from("primeira linha \nsegunda linha\n");
  const parts = [...bytes].map((byte) => Buffer.from([byte]));
  assert.deepEqual(await read(...parts), ["primeira linha ", "segunda linha", "<end>"]);
});

test("uma última linha sem quebra de linha ainda chega, antes do fim", async () => {
  assert.deepEqual(await read(Buffer.from("um\ndois")), ["um", "dois", "<end>"]);
  assert.deepEqual(await read(), ["<end>"]);
});
