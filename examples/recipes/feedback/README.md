# Tratamento de feedback de usuários

O feedback aciona a manutenção, o complemento dá continuidade ao tratamento e a resposta vem depois da verificação em produção. Os dados de exemplo são totalmente fictícios; nada está vinculado a um sistema de feedback específico e nenhuma base de chamados é construída aqui.

## Como ativar

1. Coloque o `SKILL.md` em `~/.codex/skills/handle-feedback/`; no Claude Code, em `~/.claude/skills/handle-feedback/`.
2. Mescle os `sources`, `agents`, `channels` e `rules` do `rules.json` nas regras existentes, preservando as entradas atuais; use o fuso `Asia/Shanghai`. Troque `worker` pelo computador do worker e `cwd` pelo diretório principal do seu projeto.
3. Escreva no **manual de manutenção do main** do projeto como realmente se lê o feedback, como se assume a responsabilidade por ele (se o sistema original tiver isso), como se confere a versão, como se grava o estado de volta e por onde se responde, além dos passos já existentes de entrega e de verificação em produção. Use as ferramentas já disponíveis, CLI ou MCP, sem colocar comandos e caminhos de repositório dentro dos eventos. O modelo não adivinha as suas interfaces.
4. Permissão: `edit`. Permite corrigir dentro do diretório autorizado; o shell do Codex não tem internet por padrão. Ler o feedback, abrir PR e entregar exigem ferramentas configuradas e realmente disponíveis; alterar arquivos localmente não é publicar. Verifique o ambiente de execução em segundo plano conforme a [explicação de permissões](../../../docs/plugins.md#o-que-o-access-realmente-permite) e não mude automaticamente para `full`.
5. Execute `agent-autoloop check`. Envie o evento fictício abaixo por uma fonte de teste dedicada, verifique primeiro o despacho, a pergunta e a continuidade depois da resposta, e só então conecte o feedback real.

## Como o sistema de negócio envia eventos

Use uma chave de fonte já configurada; a fonte precisa se chamar `feedback`. O comando abaixo é executado no diretório deste modelo; `FEEDBACK_KEY` vem do seu próprio gerenciador de credenciais e não deve ser escrito em arquivos nem ficar no histórico do shell.

```bash
curl --fail-with-body http://127.0.0.1:3350/v1/events \
  -H "Authorization: Bearer $FEEDBACK_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @event.json
```

Use `feedback.new` para um feedback novo e `feedback.followup` para um complemento. Um mesmo feedback usa sempre o mesmo `subject`; cada mudança real usa um `id` único e estável (por exemplo, o número do feedback mais a versão), e um reenvio preserva o número original. O `event.json` de exemplo não é um chamado real pronto para ser tratado: a entrada de leitura precisa ser configurada antes de executar, e o padrão é pedir ao titular que a complete. A fonte envia só o necessário, sem dados de contato, tokens de acesso, listas de clientes nem logs inteiros.

Eventos de fonte não representam aprovação do titular: as perguntas passam preferencialmente pelo `ask` da central, e a resposta retoma o assunto original. Se o sistema de negócio já cuida de perguntas e respostas, mantenha as decisões autenticadas daquele sistema e configure os seus próprios eventos de continuidade; não crie dois cartões ao mesmo tempo.

Por padrão, um assunto por feedback e no máximo 3 em paralelo; a capacidade de atendimento continua sendo controlada pela configuração original. Antes de enviar uma resposta para fora, confirme o destinatário e o texto integral; com autorização explícita já existente, execute dentro dela. Se a resposta falhar, refaça apenas a resposta, sem repetir a publicação já concluída.

## Notificação pelo Feishu

As regras registram por padrão o canal `feishu`. Troque `ou_REPLACE_ME` pelo open_id do titular; no `channels.feishu` do `config.json` existente, configure o `user` dessa pessoa e a chave de canal já em uso. Reaproveite o canal Feishu que já está rodando, sem abrir outra escuta. Se ele ainda não estiver conectado, siga a [configuração de canais](../../../skills/agent-autoloop/SKILL.md#conectar-um-canal); quando a configuração envolver chaves ou permissões novas, obtenha antes a autorização do titular.

A leitura dos dados de negócio usa a identidade do titular; a notificação usa a identidade do bot. Por padrão envia-se apenas ao titular; uma central entrega os cartões a todos os canais que ela tem configurados, então regras com dados privados devem declarar `channels` para enviar somente ao canal de conversa privada do titular, sem se misturar com canais de grupo compartilhados. Não faça commit no repositório de chaves, open_id reais, tokens de tabela nem dados de negócio.
