# Acompanhar erros de produção

## Que problema resolve
Depois de receber um erro, procura a causa comparando com o código local e, se for preciso reiniciar, envia um cartão perguntando a você; o script de reinicialização de exemplo apenas imprime texto.

## Como ativar
Copie o `SKILL.md` para `~/.codex/skills/ops-alerts/`; no Claude Code, use `~/.claude/skills/ops-alerts/`, e coloque o `restart.sh` no diretório do código do serviço.
Mescle o `rules.json` em `~/.agent-autoloop/rules.json`, incluindo o `askFirst`; execute `agent-autoloop check` e obtenha `$SHOP_KEY` com `agent-autoloop key new source shop`.
O sistema de erros envia eventos usando a própria chave de fonte:
```bash
curl -fsS http://127.0.0.1:3350/v1/events -H "Authorization: Bearer $SHOP_KEY" -H 'Content-Type: application/json' -d '{"id":"checkout-20261104-0310","type":"alert.error","subject":"checkout","summary":"Erro no checkout","detail":"TypeError: price is undefined at src/cart.ts:42"}'
```

## O que alterar
- Troque os dois `worker` e o `cwd` pelo computador do worker e pelo diretório do código; em `use`, escolha `codex` ou `claude`.
- Permissão: `read`. Só lê o código e a pilha de chamadas que acompanha o evento, sem precisar de internet; o plan do Claude é uma regra de aprovação de ferramentas, não um sandbox do sistema. Veja a [explicação de permissões](../../../docs/plugins.md#o-que-o-access-realmente-permite).
- Troque o `restart.sh` pelos comandos fixos de reinicialização e de verificação de saúde; antes de enviar entre computadores, configure o endereço seguindo o [manual de configuração](../../../skills/agent-autoloop/SKILL.md#servidor-e-computadores-adicionais).
- Não crie uma chave de fonte externa para `shop-fix`. O script de reinicialização não é limitado pelo `access`; quem confere se houve consentimento é o Skill, o que não pode ser tratado como aprovação obrigatória.
