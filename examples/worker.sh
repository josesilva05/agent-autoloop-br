#!/bin/sh
# Um worker curto e síncrono. Tarefas mais longas precisam de heartbeat e cancelamento, como implementa worker/worker.ts.
set -eu
: "${AGENT_AUTOLOOP_URL:?}" "${AGENT_AUTOLOOP_KEY:?}"
claim=${AGENT_AUTOLOOP_CLAIM:-curl-$$}
while :; do
  packet=$(curl -fsS --max-time 65 -H "Authorization: Bearer $AGENT_AUTOLOOP_KEY" "$AGENT_AUTOLOOP_URL/v1/work?claim=$claim&wait=50")
  job=$(printf '%s' "$packet" | jq -c '.job')
  if [ "$job" != null ]; then
    run=$(printf '%s' "$job" | jq -r '.run')
    token=$(printf '%s' "$job" | jq -r '.token')
    curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}' "$AGENT_AUTOLOOP_URL/v1/runs/$run/started" >/dev/null
    receipt=${AGENT_AUTOLOOP_RECEIPT:-'{"outcome":"done","summary":"Tratamento concluído"}'}
    curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$receipt" "$AGENT_AUTOLOOP_URL/v1/runs/$run/result"
    claim="curl-$$-$run"
  fi
  [ "${AGENT_AUTOLOOP_ONCE:-0}" != 1 ] || break
done
