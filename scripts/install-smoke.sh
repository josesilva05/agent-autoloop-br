#!/bin/sh
# A primeira hora de alguém, do começo ao fim, num home descartável: instalar com install.sh o que está commitado aqui, iniciar,
# rodar o `try` sem ninguém num terminal, responder, ver terminar, desinstalar e conferir que não sobrou nada. Só o Agent e os
# comandos que mostram uma notificação são dublês. Não usa serviço: uma máquina de CI nem sempre tem uma sessão onde rodar um.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd -P)
# Em dois passos: se o mktemp falhar dentro do `cd`, `work` seria esta pasta, e a limpeza a apagaria.
work=$(mktemp -d)
work=$(cd "$work" && pwd -P)
up_pid=""

cleanup() {
  code=$?
  if [ -n "$up_pid" ]; then
    kill "$up_pid" 2>/dev/null || true
    wait "$up_pid" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ -f "$work/up.log" ]; then
    echo "--- up.log"
    cat "$work/up.log"
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "install-smoke: $1" >&2
  exit 1
}

# Espera até 30 segundos para um comando ter sucesso.
wait_for() {
  what=$1
  shift
  tries=0
  until "$@" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 150 ] || fail "$what"
    sleep 0.2
  done
}

export HOME="$work/home"
export DISPLAY=:99
export AGENT_AUTOLOOP_HOME="$work/hub"
export AGENT_AUTOLOOP_REPO="file://$repo"
unset AGENT_AUTOLOOP_RULES AGENT_AUTOLOOP_PUBLIC_URL AGENT_AUTOLOOP_COMMIT
mkdir -p "$HOME" "$work/bin"
export PATH="$work/bin:$HOME/.local/bin:$PATH"

printf '#!/bin/sh\nexit 0\n' > "$work/bin/launchctl"
chmod +x "$work/bin/launchctl"
for notifier in osascript notify-send; do
  cat >"$work/bin/$notifier" <<END
#!/bin/sh
while [ "\$1" != "--" ]; do shift; done
printf '%s\n' "\$3" >>"$work/notified"
END
  chmod +x "$work/bin/$notifier"
done

cat >"$work/agent.sh" <<'END'
#!/bin/sh
if grep -q 'card.answered' "$AGENT_AUTOLOOP_CONTEXT"; then
  echo "Você escolheu verde, execução de teste aprovada"
else
  cat <<'ASK'
Fiz uma pergunta

```agent-autoloop
{"ask":[{"title":"Execução de teste: escolha uma cor","text":"Esta é uma execução de teste, qualquer uma serve.","options":["Azul","Verde"],"key":"try-color"}]}
```
ASK
fi
END
chmod +x "$work/agent.sh"

port=$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
healthy() { curl --noproxy '*' -fsS "http://127.0.0.1:$port/healthz"; }

sh "$repo/install.sh" --no-service --command "$work/agent.sh" --port "$port" >"$work/install.out" 2>&1 || {
  cat "$work/install.out"
  fail "install.sh falhou"
}
cat "$work/install.out"
[ -L "$HOME/.local/bin/agent-autoloop" ] || fail "install.sh não colocou o comando em ~/.local/bin"
[ "$(command -v agent-autoloop)" = "$HOME/.local/bin/agent-autoloop" ] || fail "agent-autoloop não é o que o PATH encontra"
grep -q "Primeiro rode agent-autoloop up" "$work/install.out" || fail "o próximo passo impresso não é iniciá-lo"

commit=$(git -C "$repo" rev-parse HEAD | cut -c 1-12)
agent-autoloop --version | grep -q "$commit" || fail "--version não diz $commit"

agent-autoloop up >"$work/up.log" 2>&1 &
up_pid=$!
wait_for "up não iniciou" healthy

agent-autoloop try </dev/null >"$work/try.out" 2>&1 || {
  cat "$work/try.out"
  fail "try falhou"
}
cat "$work/try.out"
card=$(sed -n 's/.*agent-autoloop answer \([0-9][0-9]*\) .*/\1/p' "$work/try.out" | head -n 1)
[ -n "$card" ] || fail "try não disse como responder"

notified() { grep -q 'Execução de teste: escolha uma cor' "$work/notified"; }
wait_for "a pergunta não chegou ao canal de desktop" notified

agent-autoloop answer "$card" 2
finished() { agent-autoloop status | grep -q 'execução de teste aprovada'; }
wait_for "status nunca mostrou que terminou" finished
agent-autoloop status | tee "$work/status.out"
grep -q 'Últimos 7 dias 2 rodadas' "$work/status.out" || fail "status não conta as duas rodadas"
grep -q '● notificação de desktop' "$work/status.out" || fail "status não mostra o canal de desktop online"

agent-autoloop uninstall --yes </dev/null
[ -f "$AGENT_AUTOLOOP_HOME/config.json" ] || fail "uninstall apagou os dados"
[ ! -e "$AGENT_AUTOLOOP_HOME/app" ] || fail "uninstall deixou o programa"
if [ -e "$HOME/.local/bin/agent-autoloop" ] || [ -L "$HOME/.local/bin/agent-autoloop" ]; then fail "o comando ainda está lá"; fi
if healthy >/dev/null 2>&1; then fail "a central ainda está em execução"; fi
wait "$up_pid" 2>/dev/null || true
up_pid=""
left=$(find "$HOME" \( -type f -o -type l \))
[ -z "$left" ] || fail "sobrou: $left"

echo "install-smoke: da instalação à desinstalação, tudo certo."
