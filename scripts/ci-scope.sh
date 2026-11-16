#!/bin/sh
# Diz de quanto CI uma execução precisa, como scope=docs, normal, kernel ou full. Texto que nenhum teste lê pula tudo, e todo o
# resto recebe os testes rápidos. A simulação só importa kernel/ e protocol/, então esses e as partes dela acrescentam uma curta:
# quebrar cada condição do kernel uma por vez mostrou que os testes rápidos já pegam o que as execuções longas fazem. As longas
# vêm com o nightly e antes de uma publicação; um pull request só as recebe para os dois arquivos que nada mais executaria, ou
# para um diff que ele não consegue obter. O que chega em main recebe os testes rápidos, texto inclusive: um commit cuja execução
# um push mais novo substituiu é verificado pela próxima, seja ela qual for.
set -u

if [ "${GITHUB_EVENT_NAME:-}" = push ]; then
  echo "scope=normal"
  exit 0
fi

# Sem --no-renames, mover um arquivo para fora de kernel/ mostraria só onde ele foi parar.
if [ "${GITHUB_EVENT_NAME:-}" != pull_request ] ||
  ! files=$(git diff --no-renames --name-only HEAD^1 HEAD 2>/dev/null) || [ -z "$files" ]; then
  echo "scope=full"
  exit 0
fi

scope=docs
while IFS= read -r file; do
  case "$file" in
    # tests/example-plugins.test.ts executa os comandos deste tutorial.
    docs/plugins.md) kind=normal ;;
    README.md | INSTALL.md | SECURITY.md | CONTRIBUTING.md | AGENTS.md | LICENSE) kind=docs ;;
    docs/* | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md) kind=docs ;;
    tests/simulation.test.ts | sim/enumerate.ts) kind=full ;;
    kernel/* | protocol/* | sim/random.ts | sim/world.ts | sim/invariants.ts) kind=kernel ;;
    *) kind=normal ;;
  esac
  case "$kind" in
    full) scope=full ;;
    kernel) [ "$scope" = full ] || scope=kernel ;;
    normal) [ "$scope" = docs ] && scope=normal ;;
  esac
done <<END
$files
END

echo "scope=$scope"
