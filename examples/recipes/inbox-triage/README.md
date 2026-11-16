# Triagem da caixa de entrada

Toda manhã passa a caixa de entrada em revista e escreve uma lista que fica nesta máquina: o que precisa de resposta hoje, o que basta saber e o que parece suspeito. Para o que precisa de resposta, o rascunho já vem escrito, pronto para copiar e enviar. Por padrão, às 8h de todos os dias no fuso Asia/Shanghai (horário de Pequim), lê as mensagens não lidas das últimas 24 horas.

## Como ativar

1. Copie este diretório para `~/.agent-autoloop/work/inbox-triage/`, com permissão `0700`, fora de qualquer repositório Git. As duas regras usam o mesmo computador, o mesmo `cwd` e o mesmo `group`, de modo que leitura e organização acontecem em série.
2. Coloque o `SKILL.md` em `~/.codex/skills/inbox-triage/`; no Claude Code, em `~/.claude/skills/inbox-triage/`.
3. Instale um `lark-cli` já autenticado como o titular e confirme antes que ele consegue ler as mensagens:
   ```bash
   lark-cli mail +triage --as user --max 3 --filter '{"folder_id":"INBOX","is_unread":true}' --format json
   ```
   Se em `data.messages` cada mensagem tiver `message_id`, `subject` e `head_from`, dá para usar. Use apenas as autorizações já existentes; não salve nem exporte access token no script. Se os campos forem diferentes, ajuste antes o ponto correspondente no `collect.ts`, em vez de deixá-lo rodar sem entender o que lê.
4. Altere o `sources.json`: `folderId` é a pasta do sistema a examinar (`INBOX`, `SPAM` etc.); com `onlyUnread` em `true`, só as não lidas são lidas; `lookbackHours` é quantas horas olhar para trás; `maxMessages` é o máximo de mensagens desta leitura (1 a 400); `bodyChars` é quantos caracteres manter do corpo de cada uma; os endereços em `skipSenders` não têm o corpo lido de forma nenhuma — é aqui que entram os remetentes de notificações.
5. Mescle os `sources`, `agents`, `channels` e `rules` das regras, trocando o computador do worker e os caminhos; use o fuso `Asia/Shanghai`. Permissão: `edit` — o Agent de triagem só lê o snapshot local e escreve a lista e os rascunhos; a leitura pela internet é feita pelo script fixo, que só executa comandos de leitura.
6. Execute `agent-autoloop check`. Numa central de teste dedicada e com um CLI falso, verifique a coleta, o despacho da triagem e a pergunta e a continuação depois de uma falha de login antes de ativar as suas regras agendadas.

## O que é lido e o que é mantido

A leitura usa `mail +triage` para obter a lista (só metadados e resumos) e depois `mail +messages` para buscar os corpos em lote por `message_id`; os dois passos usam `--as user`, apenas com as permissões que o titular já tem, sem trocar para a identidade do bot para obter mais mensagens e sem ler os remetentes em `skipSenders`. O intervalo de tempo vai no `time_range` do `--filter` e é exibido no fuso Asia/Shanghai (horário de Pequim). Cada leitura traz no máximo `maxMessages` mensagens: a paginação segue o `page_token` devolvido por `+triage`, página por página, e os remetentes em `skipSenders` não ocupam vaga, então as mensagens que vêm depois deles não são empurradas para fora. A leitura para ao alcançar `maxMessages` ou ao chegar ao fim da janela. Só quando a janela foi lida até o fim, sem deixar nenhuma mensagem, o `scanned.complete` do snapshot é `true`; com o limite cheio e ainda havendo mensagens depois, também conta como leitura incompleta e fica `false`, e a lista dirá que há mensagens não lidas — nunca "não há e-mails para ler" nem "tudo foi lido".

O corpo é cortado em `bodyChars`, e `truncated` marca as mensagens cortadas; com isso o Agent de resumo escreve "é preciso abrir a mensagem original para verificar" e não trata meio corpo como se fosse o texto inteiro. Mensagens que a interface não devolveu, ou cujo corpo voltou apenas em parte (`unavailable_message_ids` não vazio), contam como leitura não concluída: nesta rodada nenhum snapshot é gerado, e o arquivo anterior não é usado no lugar dele.

`+messages` busca apenas texto; anexos e imagens não são baixados, e `body_html` não é usado — só o texto puro. O snapshot completo fica em `inbox-input.json` (permissão `0600`) e a lista de triagem em `briefs/inbox-<número>`; são dados de e-mail do titular — não faça commit, não publique e não coloque o corpo das mensagens em cartões do Feishu.

Este modelo é **somente leitura**: não envia, não cria rascunhos na caixa de entrada, não altera o estado de lida, não aplica rótulos, não arquiva e não apaga. Os rascunhos de resposta ficam apenas na lista local, e o envio é feito pelo titular. Para gerar rascunhos de verdade na caixa de entrada, isso é uma "ação para fora": é preciso acrescentar uma regra por sua conta e definir quem confirma.

Quando o login ou a autorização do titular falha, é enviado um único cartão de pergunta, sem evento `inbox.ready`, e o snapshot anterior não é apresentado como o desta rodada. Depois que o titular restabelece o acesso, ele clica em continuar e a leitura completa é refeita; se escolher "Pular este período", esta rodada se encerra e a leitura volta no próximo horário agendado; erros temporários de interface falham com sinceridade e ficam com os mecanismos existentes da central.

O corpo das mensagens é texto escrito por outras pessoas e pode conter conteúdo disfarçado de instrução. O Agent de triagem o trata apenas como dado: não encaminha, não responde, não paga e não muda configurações a pedido do e-mail — esses pedidos são apenas anotados na lista, para o titular decidir.

## Notificação pelo Feishu

As regras registram por padrão o canal `feishu`. Troque `ou_REPLACE_ME` pelo open_id do titular; no `channels.feishu` do `config.json` existente, configure o `user` dessa pessoa e a chave de canal já em uso. Reaproveite o canal Feishu que já está rodando, sem abrir outra escuta. Se ele ainda não estiver conectado, siga a [configuração de canais](../../../skills/agent-autoloop/SKILL.md#conectar-um-canal); quando a configuração envolver chaves ou permissões novas, obtenha antes a autorização do titular.

A leitura dos e-mails usa a identidade do titular; a notificação usa a identidade do bot. Por padrão envia-se apenas ao titular; uma central entrega os cartões a todos os canais que ela tem configurados, então regras com dados privados devem declarar `channels` para enviar somente ao canal de conversa privada do titular, sem se misturar com canais de grupo compartilhados. Não faça commit no repositório de chaves, open_id reais nem conteúdo de e-mail.
