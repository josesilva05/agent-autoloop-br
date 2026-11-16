// Linhas como ACP, MCP e lark-cli as delimitam: terminadas por uma quebra de linha e por nada mais. O readline também
// termina uma em U+2028 e U+2029, que o JSON deixa como estão dentro de uma string, e com isso corta uma mensagem em duas.
import type { Readable } from "node:stream";

export function eachLine(input: Readable, onLine: (line: string) => void, onEnd = () => {}) {
  let rest = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop()!;
    for (const line of lines) onLine(line);
  });
  input.on("end", () => {
    if (rest) onLine(rest);
    onEnd();
  });
}
