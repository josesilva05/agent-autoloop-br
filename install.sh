#!/bin/sh
# Instala a Central de automação de Agents: um clone em ~/.agent-autoloop/app, sem nada para compilar e nada mais para instalar.
set -e
PUBLISHED=https://github.com/josesilva05/agent-autoloop-br.git
REPO="${AGENT_AUTOLOOP_REPO:-$PUBLISHED}"
ROOT="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
APP="$ROOT/app"
PROGRAM="$APP/bin/agent-autoloop.ts"

need_node() {
  echo "$1"
  cat <<'END'
Com Homebrew, o node@24 não entra no PATH por padrão depois de instalado; é preciso rodar estas três linhas (se você usa bash, troque ~/.zshrc por ~/.bashrc):
  brew install node@24
  echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc
  source ~/.zshrc
Com nvm:
  nvm install 24
  nvm alias default 24
Depois de instalar, rode de novo este comando de instalação.
END
  exit 1
}

command -v git >/dev/null || { echo "É preciso ter o git."; exit 1; }
command -v node >/dev/null || need_node "É preciso ter o Node.js 24 ou mais novo; não encontrei nenhum neste computador."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || need_node "É preciso ter o Node.js 24 ou mais novo; a versão atual é $(node -v)."

mkdir -p -m 700 "$ROOT"
chmod 700 "$ROOT"

# Uma cópia segue o lugar de onde veio, e o que veio do repositório público segue o Release mais novo dele, que passou
# por todas as verificações. O cli/update.ts decide do mesmo jeito, senão uma atualização falharia numa cópia que isto moveu.
from="$REPO"
if [ -d "$APP/.git" ]; then
  from=$(git -C "$APP" config --get remote.origin.url || true)
fi
release=""
if [ "$from" = "$PUBLISHED" ]; then
  # Numa linha só dele: num pipe, não receber resposta pareceria não haver Release nenhum.
  tags=$(git ls-remote --refs --tags "$PUBLISHED" 'v*')
  release=$(printf '%s\n' "$tags" | sed -n 's#.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$#\1#p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
fi
if [ ! -d "$APP/.git" ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 ${release:+--branch "$release"} -- "$REPO" "$APP"
elif [ -n "$release" ]; then
  git -C "$APP" fetch --quiet --depth 1 origin "refs/tags/$release:refs/tags/$release"
  git -C "$APP" checkout --quiet --detach "$release"
else
  git -C "$APP" pull --ff-only --quiet
fi

# Só uma pasta que esteja no PATH faz `agent-autoloop` funcionar, e um agent-autoloop que não é este é de outra pessoa, para ela manter.
place_link() {
  case ":$PATH:" in *":$1:"*) ;; *) return 1 ;; esac
  case "$1" in /*) ;; *) return 1 ;; esac
  if [ "$1" = "$HOME/.local/bin" ]; then mkdir -p "$1" 2>/dev/null || return 1; fi
  [ -d "$1" ] && [ -w "$1" ] || return 1
  if [ -e "$1/agent-autoloop" ] || [ -L "$1/agent-autoloop" ]; then
    [ -L "$1/agent-autoloop" ] && [ "$1/agent-autoloop" -ef "$PROGRAM" ] || return 1
  fi
  ln -sf "$PROGRAM" "$1/agent-autoloop"
}

usual_ifs=$IFS
IFS=:
set -f
for place in "$HOME/.local/bin" $PATH; do
  if place_link "$place"; then break; fi
done
set +f
IFS=$usual_ifs

if [ "${1:-}" = join ]; then
  "$PROGRAM" "$@"
elif [ -f "$ROOT/config.json" ]; then
  echo "Atualização concluída."
  case " $* " in *" --no-service "*) ;; *) "$PROGRAM" service install ;; esac
else
  "$PROGRAM" init "$@"
fi

if ! [ "$(command -v agent-autoloop)" -ef "$PROGRAM" ]; then
  echo
  echo "Digitar apenas agent-autoloop não executa este programa: não há no PATH uma pasta onde colocá-lo, ou há outro programa de mesmo nome aparecendo antes."
  echo "Use o caminho completo $PROGRAM, ou acrescente esta linha ao ~/.zshrc (com bash, é ~/.bashrc):"
  echo "  alias agent-autoloop='$PROGRAM'"
fi
