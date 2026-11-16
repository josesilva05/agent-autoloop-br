// O Homebrew guarda os arquivos de uma versão sob `Cellar` e apaga esse diretório na atualização seguinte; o `opt` ao
// lado é o link que a acompanha. Um programa chamado pelo caminho do Cellar morre na próxima atualização da máquina.
import { realpathSync } from "node:fs";

const CELLARS = ["/opt/homebrew", "/usr/local"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const resolve = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * O caminho que continua valendo depois de uma atualização: `opt` quando ele aponta para este executável, e também
 * quando o diretório deste executável já sumiu e o `opt` ainda resolve. Um processo de vida longa sobrevive ao
 * diretório de versão de onde partiu, então os filhos que ele inicia precisam do link, não daquele caminho.
 */
export function stablePath(executable: string, cellars = CELLARS) {
  const cellar = new RegExp(`^(${cellars.map(escape).join("|")})/Cellar/([^/]+)/[^/]+/bin/([^/]+)$`).exec(executable);
  if (!cellar) return executable;
  const opt = `${cellar[1]}/opt/${cellar[2]}/bin/${cellar[3]}`;
  const linked = resolve(opt);
  // Sem link, ou um link que não leva a nada: não há opção melhor do que o que já está em execução.
  if (!linked) return executable;
  const current = resolve(executable);
  // Apagado por uma atualização enquanto este processo continuava rodando: agora só o link consegue iniciar algo.
  if (!current) return opt;
  return current === linked ? opt : executable;
}
