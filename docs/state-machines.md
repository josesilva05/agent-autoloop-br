# Estados e transições

Aqui estão reunidos a localização autoritativa de cada estado, quem o escreve e suas restrições; os campos HTTP estão no [protocolo](protocol.md). Uma rodada `done` não significa que o assunto não tenha continuação, e `delivery=success` não significa que necessariamente foi para produção.

## Eventos, assuntos e rodadas

| Objeto | Estado e armazenamento | Quem altera, e onde |
| --- | --- | --- |
| Evento | Deduplicação por `source + key` em `events`; `routed/paused/hops` distinguem despachado, ignorado por pausa, sem ninguém para assumir e não despachado além de 8 saltos — depois de registrados, não mudam mais; a reexecução não altera o evento, que conta como reexecutado ao ser anexado a uma rodada desta regra | `ingest/recordEvent` em `kernel/decide.ts` recebe fontes, recibos, respostas, relógio e execuções manuais; `replayRule` reexecuta os eventos ignorados durante a pausa |
| Assunto | Não há coluna de estado própria; as rodadas, os cartões em aberto e as reverificações futuras associadas a `rule + lane` expressam o progresso em conjunto | `enqueue/answer/tick/retryLater`; eventos que chegam durante a execução vão para a rodada seguinte e, em caso de falha, a fila do mesmo assunto é fundida na rodada de nova tentativa |
| Rodada | `runs.state`: `queued → claimed → done/nothing/cancelled`; `claimed → unknown`; a falha volta de claimed/unknown para queued, e `attempts/not_before` expressam a espera por nova tentativa | `claimNext/finish/applyReceipt/retryLater/cancel/stopRun/sweep`. unknown não é falha: resultados atrasados continuam sendo aceitos e o trabalho novo seguinte pode prosseguir |
| Parada | `claimed + cancel_at` indica que está parando; só vira cancelled quando o processo termina; na fila pode ser cancelado diretamente | `cancel` pelo titular; o worker para todo o grupo de processos e então entrega o resultado. Um failed recebido durante a parada também conta como cancelled e não pode ser despachado de novo |
| Propriedade da execução | `agent/rules_version/issued/claim` fixam a propriedade da reserva; `session/resume` são indicações de continuação | `assignQueued/settleSession/claimNext/started/finish`. Na fila vale a regra mais recente; após a reserva, mantêm-se o worker original e o snapshot da regra; um claim repetido troca o token |

`done + pergunta open` e `done + reverificação futura` são ambos válidos: apenas esta rodada termina. O máximo é de 10 falhas consecutivas, e rodadas em estado terminal não podem ser reagendadas. Para refazer, o titular usa um evento novo ou `run` manual. Os `last_issued/last_result/last_answer` já devolvidos garantem que reentregar o mesmo conteúdo com o mesmo token seja confirmado uma única vez; conteúdo diferente retorna 409.

É proibido reservar duas rodadas ao mesmo tempo no mesmo grupo e lane, tentar de novo automaticamente após a parada, trocar de Agent reaproveitando a sessão do Agent antigo, e perder o lane original em respostas/reverificações. Depois que o unknown libera o grupo, uma rodada nova ainda não pode abrir uma sessão que talvez esteja em uso. As verificações de concorrência, de sessão original e de token são feitas de forma unificada nas entradas citadas acima.

## Cartões, entrega, reverificação e pausa

| Objeto | Estado e armazenamento | Quem altera, e onde |
| --- | --- | --- |
| Pergunta | `cards.state`: `open → decided → done` ou `open → closed` | `createCard` cria; `answer` confere titular, canal e ref da mensagem, altera apenas open e produz `answer_event`; só o `applyReceipt` que processar a resposta com sucesso escreve done; `resolve/closeCard` indicam que nenhuma decisão é necessária |
| Notificação | Notificação comum: open → closed; FYI já nasce closed | `cardFromReceipt/notify/tell` criam; o titular ou um recibo dentro do escopo permitido encerram. decided não significa executado; se a continuação for cancelada, a decisão é preservada e done não é forjado |
| Entrega | Combinação de `version/ref/tries/not_before/given_up` em `deliveries[card_id:channel]`: não enviada, alugada, aguardando nova tentativa, sincronizada, desistida | `nextCard` aluga para o canal, `delivered` confirma e `failed` agenda nova tentativa; quando a versão do cartão é mais alta, a mensagem original é atualizada. Além da janela, desiste; um tell repetido pode reiniciar uma entrega desistida |
| Reverificação | `timers.event_id=null` significa aguardando; não nulo, já disparada. Só uma pendente por `rule/lane/key` | `scheduleReview` define, remaneja e cancela; `tick` registra o timer.due único e despacha de volta ao assunto original; depois que a regra é apagada, o vencimento apenas mantém o registro, sem despachar |
| Agendamento | `schedules.cron/next_at/skipped_at`; não é um estado de conclusão de negócio | `tick` atualiza; uma ocorrência perdida compensa apenas a mais recente, mudar a configuração reinicia a contagem de tempo e, durante a pausa, é ignorada |
| Pausa | Um registro válido em `pauses[name]` indica pausa, com since/until; retomar apaga, e a resposta devolve o registro apagado | `pauseRule/resumeRule` pelo titular e `tick` no vencimento. O que já foi reservado não é afetado; fila, respostas e reverificações permanecem na fila; eventos novos de fonte são ignorados e a retomada não os repõe automaticamente; `replayRule` do titular reexecuta os eventos ignorados desde since, uma vez cada; durante a pausa não é possível executar manualmente nem reexecutar |

A resposta e o encerramento de um cartão são mutuamente exclusivos: só um dos dois pode acontecer. Um recibo de falha permite apenas notificar — pergunta, encerramento, reverificação e emissão de eventos não têm efeito. Cartão e entrega com versões diferentes é apenas uma sincronização pendente, e não deve ser entendido como cartão reaberto.

A reverificação guarda o `agent` e a `session` de quem a criou, e só continua a sessão se a regra ainda despachar para o mesmo Agent. Reverificações de logs antigos sem `agent` vencem normalmente e mantêm os dados, sem forçar o reaproveitamento da sessão antiga; a decisão de continuar a sessão mais recente do Agent atual segue o resume da regra. Fatos antigos não são migrados. A continuação de cartões já tem a mesma verificação de propriedade.

`due` é um índice de relógio calculado por `kernel/due.ts`, confirmado na mesma transação que o fato de negócio; não é um estado de negócio adicional. `kernel/store.ts` tem exclusividade sobre o acréscimo de fatos, e `kernel/evolve.ts` sobre a escrita das projeções persistentes.

## Execução local do worker

O estado fica em `worker/runs/<run>-<attempt>/entry.json` e nos arquivos stdout e exit, e é alterado por `worker/worker.ts`: `start` salva primeiro a tarefa reservada; `launch` salva o turn e então inicia o grupo de processos marcado; `check` combina pid, comando real do processo e marca de saída para distinguir em execução, não verificável e encerrado; `stop` salva stopping/why e, quando o grupo de processos realmente termina, `conclude` obtém o resultado; a reescrita de recibos é expressa por repairs/turn/resume, no máximo duas vezes; `endWith` persiste o result primeiro e `settle` então confirma; aceite ou recusa explícita 4xx removem o entry, enquanto 5xx ou falha de conexão o mantêm; `tidy` limpa apenas diretórios expirados sem entry.

Não conseguir ler o processo não significa que ele saiu, um código de saída ainda não escrito não significa falha, e uma interrupção depois de a sessão ter sido continuada não pode ser refeita em outra sessão.

## Entrega de PR, revisão e publicação

A autoridade está no PR do GitHub (head/base/draft/closed/merged/auto_merge), nos rótulos, nos status de commit, nos workflows e na versão saudável. Eventos de progresso servem apenas para exibição. `plugins/delivery/delivery.ts` relê a cada passo, e `run.ts/handoff.ts` cuidam da devolução e da nova verificação agendada.

| Estado | Condição autoritativa e ponto de alteração |
| --- | --- |
| Aguardando entrega | CLI de passagem/titular adiciona deliver; `poll.ts` emite eventos estáveis com base em eventos de PR, head e rótulo, sem manter cursor |
| Assumido/em revisão | O executor escreve delivery=pending e lê as configurações fixadas na main; `review.ts` executa a política |
| Aguardando correção | Status de revisão failure, ou livro de revisão confiável com itens pendentes; não vale revisar de novo o mesmo commit para apagar descobertas |
| Em verificação | O workflow pull_request mais recente do head atual e os jobs de matriz exigidos foram bem-sucedidos; verificações anteriores à conversão em ready não contam |
| Em merge | main/head/base/rótulos/política ainda coincidem; o executor chama merge/auto-merge e relê o resultado — se a resposta se perder, confirma primeiro |
| Em publicação | PR já mesclado e deliver ainda presente; `waitLive` aguarda o sucesso de um Ship que cubra o merge e confere a versão em produção |
| live | Ship bem-sucedido e a versão saudável contém o alvo; o executor escreve delivery=success, limpa o rótulo e reporta a fase |
| merged/docs_only | Não há serviço em produção e só o merge foi concluído; ou a diferença completa entre a versão saudável e o alvo contém apenas documentação interna, sem necessidade de ir para produção; a descrição deve distinguir os casos |
| reviewed | deliver-review pede apenas revisão; ao concluir, limpa o rótulo; falha ao limpar parcialmente não pode virar entrega completa |
| returned | delivery=failure; remove deliver/deliver-review; deliver-attended é reservado por quem fez a passagem, e só depois de três minutos sem reserva o recado é transmitido pela regra existente |
| withdrawn | deliver retirado durante a verificação, auto-merge desativado; termina com sucesso sem merge nem publicação e reporta a retirada explicitamente; não equivale a live |
| retrying | O delivery-retry de um later da central guarda head e contadores de erro do GitHub/de execução; trocar o head zera os contadores e atingir o limite devolve; quando não é possível gravar o resultado, mantém-se a reentrega |

Ao fechar um PR não mesclado, escreve-se primeiro a falha de delivery e só depois se limpa o rótulo, evitando que quem espera fique preso em pending. ask-owner é o estado de recado de uma Issue separada: só é limpo quando o recado é entregue com sucesso, e não é uma fase de produção. A fonte só reconhece o status `delivery-agent/<nº do PR>` de contas confiáveis; o livro de revisão no corpo do PR vincula, ao status confiável, rodada, head, revisor e resumo do corpo. Estar dispensado de revisão não é ter sido aprovado na revisão, e preencher "tratado" não é concluir a nova revisão.

## Base histórica e registros antigos conhecidos

| Commit Git / PR | Problema original e restrição |
| --- | --- |
| cbf158a / #111 | Entregar a falha primeiro após a parada causava reagendamento; a mudança em parallel fazia respostas/reverificações caírem no assunto errado. Parada com falha conta como cancelled, e o lane é preservado |
| fdacb94 / #54 | Depois de apagar a regra, a fila ficava para sempre sem ninguém para reservá-la; agora é cancelada e notificada |
| 4a0094f / #67 | Encerramento por falha perdia uso do recibo, sessão e deduplicação; agora os fatos desta execução são preservados |
| c94a9c5 / #60 | Interrupção com sessão já continuada passava a abrir sessão nova e refazer; agora só se abre sessão nova quando não foi possível retomar |
| 21594a5 / #211 | Incidente real registrado explicitamente: após erro de WebSocket, o fallback para HTTPS concluiu, mas ainda assim foi julgado como falha pelo erro antigo; 12 refações bem-sucedidas, consumindo 1,11 milhão de Tokens de entrada. O evento de conclusão agora limpa erros de conexão anteriores |
| ad0384f / #118 | FYI closed sem closed_at; os registros novos foram corrigidos, e fatos antigos não têm horário forjado |
| f25ce4a / #113, 4f971cd / #88 | Revisões repetidas deixavam de ver descobertas originais; encerrar a rodada depois de sincronizar a main fazia o sistema perseguir a main para sempre. Agora vincula-se ao commit e sincroniza-se na mesma rodada |
| 5285e0e / #240, e8748fd / #242 | Fronteiras atuais de entrega multiprojeto, livro de revisão confiável e nova tentativa emergencial; não se pode mais inferir a partir do processo de entrega já aposentado |

#245 corrigiu três pontos depois de reproduzi-los em regressão: reverificação carregando sessão entre Agents, withdrawn sem estado terminal de progresso e PR fechado permanecendo em pending, cobertos respectivamente por `tests/resume-thread.test.ts`, `tests/delivery.test.ts` e `tests/delivery-run.test.ts`. Reproduzir em código não equivale a um incidente de produção confirmado.
