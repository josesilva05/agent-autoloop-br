# Protocolo

O sistema inteiro é um ciclo, com três aberturas.

```
         eventos              pegar trabalho
  Fontes ─────────▶  Central  ◀───────── worker ── Agent
                      ▲ │
            respostas │ │ cartões
                      │ ▼
                     Canais ◀──▶ você
```

**O kernel da central não conecta nada por iniciativa própria.** Fontes, workers e canais é que se conectam a ela: o kernel não precisa saber onde estão, em que linguagem foram escritos nem de que fornecedor são, e não guarda as credenciais deles; o seu computador não precisa abrir nenhuma porta. O protocolo é este HTTP + JSON abaixo, e escrever um plugin novo exige apenas saber enviar requisições HTTP.

No uso em um único computador, um comando executa os três no mesmo processo, e eles continuam trocando mensagens por este protocolo.

**A central não tem interface.** Você interage com ela pelos canais e pela linha de comando. Se quiser uma página ou um painel grande, monte você mesmo com as requisições da seção “O titular”: ela é um cliente em pé de igualdade com a linha de comando.

## Seis palavras

Os estados, escritores e restrições de histórico que atravessam objetos estão concentrados em [Estados e transições](state-machines.md).

| Palavra    | O que é                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evento** | Algo aconteceu: fonte, número, tipo, objeto, uma frase, detalhes e um link de volta à origem. O horário atingido é um evento, e o seu clique em um cartão também é.     |
| **Regra**  | Escrita em `rules.json`: que evento, para qual Agent, em qual diretório, com qual Skill e quando avisar você.                                                          |
| **Assunto** | O que diz respeito ao mesmo objeto sob a mesma regra. Os eventos são agrupados em assuntos, e cartões, reverificações vencidas e sessões ficam pendurados no assunto. Quando a regra não define `parallel`, a regra inteira é um único assunto. |
| **Rodada** | Uma execução: pega um lote de eventos, entrega um recibo e termina. A rodada termina; o assunto continua.                                                               |
| **Recibo** | A última mensagem do Agent. Tudo o que ele quer que a central faça está escrito aqui e entra em vigor de uma vez, em uma única transação, ao fim da rodada.             |
| **Cartão** | Aquilo que é mostrado a você. Com opções é uma pergunta: o que você escolher vira um novo evento e o assunto segue em frente; sem opções é uma notificação.             |

## Seis princípios

1. **Atenção é o recurso mais caro.** O padrão é o silêncio. Nada de falar sem necessidade; o que dá para fazer sozinho é feito até o fim, e só interrompem você as coisas que a regra manda perguntar antes e os bloqueios que realmente exigem que o titular os desfaça.
2. **Tudo é evento.** Sistemas externos, tempo, reverificações vencidas e as suas decisões seguem pelo mesmo caminho.
3. **Tudo se conecta para dentro.** O kernel não faz requisições para fora. As credenciais ficam onde são usadas, e o raio de um incidente fica lá também.
4. **O Agent é simplesmente um processo.** Recebe um prompt e imprime a última mensagem. Claude Code, Codex, qualquer Agent de linha de comando, um script, um pipeline de CI: tudo igual, sem necessidade de SDK. O processo que dispara trabalho remoto é responsável por acompanhar até o fim de verdade antes de encerrar.
5. **A rodada não espera ninguém.** Se precisar perguntar, encerra a rodada e só volta a processar depois de receber a resposta, retomando a sessão original sempre que possível. Enquanto espera você, não ocupa processo nem gasta tokens, e uma reinicialização não perde nada.
6. **Só a regra é instrução.** O evento não decide para quem vai, em que diretório, com qual Skill nem com que permissões; isso só a regra decide. O que outras pessoas escreveram não entra no prompt, vai apenas para arquivos marcados como “material de referência”. Isso não impede toda injeção de prompt, mas limita o pior resultado ao escopo que a regra concedeu.

## Regras

```jsonc
{
  "timezone": "Asia/Shanghai", // fuso usado para agendamentos e para o “hoje”; padrão é o fuso do sistema
  "askFirst": ["apagar dados", "derrubar serviço", "gastar dinheiro", "enviar mensagem para fora"], // só nestas categorias o Agent pergunta a você antes
  "sources": { "shop": { "name": "shop" }, "github": { "name": "GitHub", "adapter": "github" } },
  "agents": {
    "claude": {
      "name": "Claude Code",
      "worker": "mac-mini",
      "use": "claude",
      "model": "…",
      "effort": "high",
      "access": "edit",
      "tier": "…", // opcional: nível de serviço; hoje só o plugin do Codex usa, repassado como está para o service_tier dele — por exemplo, "priority" é o Fast no app do Codex; sem isso, segue a configuração do próprio Codex naquele computador
      "program": "…", // opcional: o plugin embutido inicia este programa em vez do detectado automaticamente, por exemplo um script que prepara variáveis de ambiente e então dá exec em claude
    },
    "cursor": {
      "name": "Cursor",
      "worker": "mac-mini",
      "use": "command",
      "command": ["agent", "-p", "--trust", "{prompt}"],
    },
  },
  "channels": { "feishu": { "name": "Feishu", "answerers": ["ou_xxx"] } },
  "defaultChannels": ["feishu"], // opcional: cartões e notificações que não definem channels por conta própria (tell, alertas da própria central, perguntas de tarefas agendadas em outro lugar, regras sem channels) só são enviados a estes canais; se omitido, vão para todos os canais
  "rules": [
    {
      "name": "Tratar alertas",
      "when": { "source": "shop", "types": ["alert.*"] }, // ou { "cron": "0 9 * * *" }
      "to": "claude",
      "cwd": "~/code/shop",
      "skill": "run-ops",
      "prompt": "Processe conforme a seção …… dele.",
      "title": "alert-{id}", // opcional: título da sessão, colocado na primeira linha do prompt; {subject} é o objeto comum aos eventos desta rodada e {id} é o último segmento dele após dividir por / # :
      "group": "ops", // o mesmo grupo executa uma rodada por vez; o padrão é o nome da regra
      "parallel": 3, // quando definido, os assuntos são divididos por objeto: o mesmo objeto executa uma rodada por vez, este grupo no máximo 3 rodadas, ainda limitado pelo worker.capacity do worker (padrão 2)
      "resume": true, // eventos novos do mesmo assunto retomam a sessão da rodada anterior; o padrão é abrir uma sessão nova a cada vez
      "tell": "needed", // always envia em toda rodada concluída (não envia em NADA A FAZER nem em FALHOU) / needed só quando há cartões (padrão) / never suprime apenas as notificações do recibo; perguntas e alertas da própria central continuam sendo enviados
      "emits": { "source": "shop", "types": ["pr.*"] }, // quais eventos o recibo pode emitir; sem isso, não pode emitir nenhum
      "channels": ["feishu"], // os cartões e notificações desta regra só vão para estes canais; se omitido, segue defaultChannels
    },
  ],
  "elsewhere": [
    {
      "name": "Limpeza semanal",
      "source": "shop",
      "to": "claude",
      "cron": "0 6 * * 0",
      "where": "Tarefa agendada do app Claude",
      "model": "…", // opcional: o modelo e o nível de raciocínio definidos para ela no app; usados apenas para exibição
      "effort": "high",
      "cwd": "~/code/shop",
      "skill": "weekly-sweep",
      "prompt": "Processe conforme a seção “A resposta chegou” dele.", // opcional: usado quando precisa perguntar a você; depois da resposta, continua aqui seguindo isto
    },
  ],
}
```

`cwd` é interpretado pelo computador que aceita o trabalho; podem ser usados caminhos absolutos Unix, letras de unidade ou caminhos UNC do Windows e caminhos de diretório pessoal começando com `~/` ou `~\`. A central e o computador que aceita o trabalho podem usar sistemas operacionais diferentes. Aceitar caminhos do Windows é uma extensão de capacidade compatível: `/v1`, as regras e o uso dos plugins continuam iguais.

`elsewhere` são tarefas agendadas executadas em outro lugar: a central não as inicia, apenas as lista em `agent-autoloop status`, e elas usam `POST /v1/tell` quando precisam falar com você. As que definem `cwd` (junto com `skill` ou `prompt`) também podem fazer perguntas: o cartão vem com opções e, quando você responde, a central acorda o `to` como em uma rodada de regra e continua em `cwd` seguindo `skill` e `prompt`. O grupo dessa rodada é o nome da tarefa, uma rodada por vez, sem retomar a sessão da própria tarefa agendada. Se a regra estiver escrita errado, a alteração do arquivo não entra em vigor, as regras antigas continuam rodando e um cartão é enviado dizendo onde está o erro. Você pode preencher `model` e `effort`, ou seja, o modelo e o nível de raciocínio definidos para essa tarefa no app: a central não os usa para iniciar nada, apenas os devolve no `elsewhere` de `GET /v1/state` para os clientes que exibem essas tarefas; se não forem definidos, não são enviados. É uma extensão compatível: os arquivos de regra existentes não precisam mudar.

Com `resume` definido, se ao começar a rodada a rodada anterior do assunto estiver concluída (inclusive NADA A FAZER) e tiver deixado uma sessão, aquela sessão é retomada; a sessão vai ficando cada vez mais longa e os tokens e o custo sobem junto. Abre-se uma sessão nova nestes casos: a rodada anterior foi interrompida (por você ou por falhas consecutivas), e retomá-la muito provavelmente daria o mesmo resultado; a rodada anterior foi executada por outro Agent; a rodada anterior não deixou sessão. Sem `parallel`, a regra inteira é um assunto e todos os eventos usam a mesma sessão; eventos sem `subject` também contam como o mesmo assunto. Respostas e reverificações vencidas voltam à sessão da pergunta e do combinado quando o Agent não mudou, e as rodadas reexpedidas também permanecem na própria sessão. Se o log antigo da reverificação não registrou a qual Agent pertencia a sessão, o material da reverificação é preservado, a sessão antiga não é reaproveitada à força e a regra de resume continua decidindo se a sessão mais recente do Agent atual é retomada.

Retomar a sessão original para respostas e reverificações exige reler a sessão inteira; quando ela é longa, até uma rodada que não fez nada pode gastar mais de 100 mil tokens. Para o que espera muito tempo e repetidamente por uma recuperação externa (interface, cota, moderação), não use `later` de forma recorrente para voltar a sessões longas: escreva outra regra com `use: "command"` (com `emits`) que rode um script de sondagem por agendamento e só emita o evento quando houver recuperação — sem recuperação, nenhum token é gasto. A regra que continua o trabalho não define `resume`, abre sessão nova, e o contexto necessário vai no evento ou na Skill. Deixe `later` para reverificações em que a sessão ainda é curta ou em que é preciso seguir o contexto daquela sessão.

`title` serve para os clientes que nomeiam pela primeira mensagem: quando definido, ocupa sozinho a primeira linha do prompt (o plugin do Codex acrescenta um trecho explicativo antes do prompt, então não fica na primeira linha), as rodadas do mesmo assunto têm o mesmo nome e assuntos diferentes ficam separados. Deve ser uma única palavra que comece com letra ou número e não contenha espaços: alguns clientes pegam apenas a primeira palavra, e o prompt é passado como argumento para a linha de comando do Agent, então o objeto não pode vir no início, para que objetos começando com `-` ou `/` não sejam interpretados como opção ou comando. Só os marcadores `{id}` e `{subject}` são reconhecidos. `subject` contém apenas caracteres validados e já entra no prompt; se os eventos desta rodada tiverem mais de um objeto, ou nenhum objeto (como em agendamentos), o marcador fica vazio. Sem `title`, o prompt da regra é igual ao de antes.

O `parallel` de regras do mesmo grupo é o limite do grupo inteiro. Também é possível definir `maxActive` para uma regra individual, limitando quantas rodadas aquela regra pode pegar ao mesmo tempo; cada assunto continua com a própria fila. Definir `maxActive` para um Agent em `agents` limita quantas rodadas ele pode pegar ao mesmo tempo em todas as regras. Os dois valores são opcionais e, quando preenchidos, devem ser inteiros positivos. Os três limites valem simultaneamente; depois de reduzi-los, espera-se as rodadas já pegas terminarem antes de despachar novas.

Com ou sem `resume`, se a sessão que a rodada deveria retomar ainda tiver outra rodada não concluída, ou se não houver mais notícias dela e talvez ainda esteja em execução, esta rodada abre uma sessão nova, para não ter dois processos na mesma sessão; o conteúdo das respostas e das reverificações continua sendo entregue a ela.

Tarefas na fila e aguardando nova tentativa adotam, no momento do claim, o Agent, o diretório, o prompt e as permissões mais recentes; se o Agent mudou, a sessão do Agent antigo não é levada. Tarefas já pegas mantêm a configuração de Job e o worker do momento do claim: claims repetidos, heartbeats, parada e recuperação após reinicialização não trocam de responsável a cada atualização de regra. Assuntos aos quais eventos já foram atribuídos não são redivididos nem mesclados; respostas e reverificações vencidas voltam ao assunto do momento da pergunta e do combinado, mesmo que a regra tenha removido `parallel` depois. As permissões de evento e o modo de notificação do recibo continuam sendo verificados pela regra vigente no envio.

## Fontes: transformar o mundo em eventos

```
POST /v1/events                    Authorization: Bearer <chave da fonte>
{ "id": "12:new", "type": "feedback.new", "subject": "#12", "summary": "…", "detail": "…", "link": "https://…" }
→ 200 { "event": 34, "duplicate": false, "routed": ["Tratar feedback"] }
```

- `id` e `type` são obrigatórios. A mesma fonte com o mesmo `id` é registrada uma única vez, então a fonte pode reenviar à vontade.
- `subject` só pode ser um identificador (letras, números e `# . _ : / @ -`) e `link` só pode ser uma URL em ASCII puro, porque entram no prompt. `summary` e `detail` não entram no prompt.
- Eventos sem nenhuma regra correspondente também são guardados e aparecem em `agent-autoloop status`.
- Limites dos campos: `id` 200 caracteres, `subject` 100, `summary` 200, `detail` 4000, `link` 500 e `type` 64 caracteres.

Para saber o que aconteceu com os eventos que enviou, a fonte consulta pelo número `event` devolvido na resposta, usando a mesma chave; basta consultar de tempos em tempos os que ainda não terminaram:

```
GET /v1/events/34                  Authorization: Bearer <chave da fonte>
→ 200 { "event": 34, "routed": ["Tratar feedback"], "paused": [], "runs": [
    { "run": 41, "rule": "Tratar feedback", "state": "done", "attempts": 0, "error": null,
      "finishedAt": "2026-11-07T08:00:00.000Z", "summary": "…", "events": [ { "id": "…", "type": "…", … } ] } ] }
```

- Só é possível consultar os próprios eventos. Eventos de outras fontes são tratados como inexistentes e devolvem 404.
- `runs` são todas as rodadas em que este evento está agora, ordenadas por número. Na nova tentativa de uma rodada que FALHOU, eventos posteriores do mesmo assunto são incorporados, então um evento já incorporado aparece na rodada mais antiga. Depois que o titular reexecuta eventos pulados durante uma pausa, `paused` não muda e `runs` ganha a rodada da reexecução.
- `attempts` é quantas vezes esta rodada já falhou; `error` é o motivo da falha mais recente, limpo depois de concluída.
- `summary` é a frase do recibo; `events` são os eventos emitidos pelo recibo e recém-registrados pela central (escritos igual ao recibo). Os que têm o mesmo `id` de um evento já existente são registrados uma única vez e não contam nesta rodada. Quando a rodada também incorporou eventos de outras fontes, os dois campos são `null`: foram escritos depois que o Agent leu material de outros. Em versões anteriores a esta interface, os eventos emitidos pelo recibo não eram registrados na rodada e `events` vinha vazio.

| `state`     | Significado                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | Na fila; com `attempts` maior que 0, falhou e está aguardando nova tentativa                                                                              |
| `claimed`   | O worker pegou; Em execução                                                                                                                              |
| `unknown`   | O worker não reportou esta rodada por 5 minutos; Incerto se ainda está em execução. O resultado entregue depois continua sendo aceito                     |
| `done`      | Concluída                                                                                                                                                |
| `nothing`   | Visto, NADA A FAZER                                                                                                                                      |
| `cancelled` | Terminou sem concluir: 10 falhas consecutivas sem nova tentativa, regra removida (`summary` diz qual dos casos) ou interrompida pelo titular               |

Três outras formas de entrada, todas o mesmo tipo de evento ao chegar na central:

- **Agendamento**: a regra define `cron`. Os horários perdidos (por exemplo, com o computador tampado) são repostos apenas na ocorrência mais recente ao acordar. Horários repetidos (horário de verão) rodam só na primeira vez; horários inexistentes são pulados.
- **Webhook de terceiros**: `POST /v1/in/<fonte>`. Se a fonte configurar `adapter`, a função em `plugins/<adapter>/source.ts` valida a assinatura e traduz em eventos; ela apenas traduz, não envia requisições. O segredo usado na validação de assinatura fica em `secrets.env` como `AGENT_AUTOLOOP_SECRET_<fonte>` (nome da fonte em maiúsculas, `-` trocado por `_`, reinicie a central depois de alterar) e não entra no `rules.json`.
- **Polling**: não precisa de acesso à rede pública e não gasta tokens quando não há nada novo. A regra chama um script por agendamento (que também é um Agent) e o script devolve os novos eventos no `events` do recibo. O `id` dos eventos deve ser estável; as faixas de leitura podem se sobrepor, pois a central deduplica. O script só deve avançar o próprio cursor depois de entregar o recibo, ou então nem manter cursor.

Quando uma fonte ou uma tarefa `elsewhere` tem algo para dizer diretamente a você (sem passar por um Agent):

```
POST /v1/tell    { "key": "weekly-44", "text": "…" }                     Authorization: Bearer <chave da fonte>
POST /v1/tell    { "task": "Limpeza semanal", "key": "x", "text": "…" }   Authorization: Bearer <chave do worker>
→ 200 { "card": 56, "duplicate": false }
```

O que é dito assim é uma notificação apenas informativa (`fyi`), sem botões, enviada uma única vez por `key`. Quando uma tarefa `elsewhere` com `cwd` precisa que você decida, use `ask` no lugar de `key` e `text`, com o mesmo conteúdo do `ask` do recibo:

```
POST /v1/tell    { "task": "Limpeza semanal", "ask": { "title", "text", "options": ["…", "…"], "recommend": 0, "about": "…", "key": "…" } }
                                                                         Authorization: Bearer <chave do worker>
→ 200 { "card": 57, "duplicate": false }
```

Se o cartão com o mesmo `key` (ou, sem ele, com o mesmo título e conteúdo) ainda estiver aberto, não é enviado de novo. Quando você responde, a central acorda o Agent dessa tarefa para continuar em `cwd`, e a resposta vem no `answers` da rodada; ao concluir, o cartão muda para executado. Perguntas de tarefas sem `cwd` devolvem 400. Centrais antigas não conhecem `ask` e devolvem 400: quando central e worker são implantados separadamente, atualize primeiro a central.

## Agent: pegar trabalho, executar e entregar o recibo

Cada computador tem um worker, que só faz conexões para fora. Um worker pode atender vários Agents.

```
GET /v1/work?claim=<número desta chamada de trabalho>&wait=50&running=7,8&capacity=1    Authorization: Bearer <chave do worker>
→ 200 { "job": null | Job, "cancel": [7] }
```

- Sem trabalho, espera no máximo `wait` segundos e retorna imediatamente assim que chega trabalho novo. `running` são as rodadas em andamento em mãos e serve também como heartbeat. `capacity=0` apenas se registra, sem pegar trabalho.
- Com trabalho em mãos, pode vir a cada segundo pedir trabalho e verificar cancelamentos. O heartbeat entra no log no máximo uma vez por minuto, com um único registro independentemente de quantas rodadas estiverem em mãos; o mesmo vale para o canal ao pegar cartões. Por isso, o `seenAt` de `/v1/state` pode ser até um minuto anterior à última visita, e as condições “5 minutos sem reportar” e “10 minutos sem conectar” também podem ser avaliadas até um minuto antes; `online` mantém essa folga de um minuto, contando como Online por até 3 minutos após o registro.
- Se a resposta se perder, repita com o mesmo `claim` e receberá o mesmo trabalho.
- `cancel` são as rodadas a interromper. No Unix, o worker primeiro envia o sinal de parada a todo o grupo de processos e, se ainda houver processo rodando depois de 10 segundos, encerra à força; no Windows, cada rodada roda em um Job Object próprio e a parada encerra toda a árvore de subprocessos. Só depois de confirmar que o processo parou é que entrega `outcome: "cancelled"`, e só então o assunto é liberado. Reiniciar o worker durante a parada continua esta etapa. Se a rodada a ser interrompida devolver `failed`, também conta como parada e não haverá nova tentativa.

```jsonc
// Job: tudo sobre uma rodada. O token vale apenas para esta execução desta rodada.
{
  "run": 12, "token": "…", "attempt": 1,
  "rule": { "name": "Tratar alertas", "cwd": "~/code/shop", "skill": "run-ops", "prompt": "Processe conforme a seção …… dele.", "title": "alert-{id}" },  // title é entregue ao worker como está; se não for definido, não existe
  "agent": { "id": "claude", "name": "Claude Code", "use": "claude", "model": "…", "effort": "high", "access": "edit" },
  "session": null,       // a sessão a retomar sempre que possível: na reexpedição é a anterior, quando chega resposta é a da rodada da pergunta e, com resume na regra, é a da rodada anterior deste assunto. Se não der para retomar, abre-se uma nova, então é apenas uma otimização
  "askFirst": ["apagar dados", "…"],
  "context": {           // o worker escreve isto em arquivos e entrega ao Agent; tudo é material de referência
    "events":  [{ "id", "source", "sourceName", "type", "subject", "summary", "detail", "link", "receivedAt" }],
    "answers": [{ "card", "title", "options", "choice", "chosen", "text", "about", "by", "at" }],  // as decisões que esta rodada deve levar adiante; choice é o índice a partir de 0, chosen é o texto da opção escolhida e, em respostas de texto livre, é a própria resposta
    "timers":  [{ "key", "about", "at" }],                                               // as reverificações vencidas desta rodada
    "waiting": [{ "key", "about", "at" }],                                               // as reverificações deste assunto que ainda não venceram
    "open":    [{ "card", "title", "text", "at" }],                                      // cartões da mesma fonte e do mesmo grupo ainda não encerrados
    "decided": [{ "card", "title", "choice", "at" }]                                     // o que já foi decidido neste assunto, válido apenas para aquela questão; choice já é o texto da opção escolhida, não o índice
  }
}
```

```
POST /v1/runs/12/started   Authorization: Bearer <token>   { "session": "…", "link": "claude://…" }
POST /v1/runs/12/result    Authorization: Bearer <token>   Result
→ 200 { "rejected": [{ "card": 9, "reason": "Fora do escopo de verificação desta rodada" }] }
```

```jsonc
// Result
{
  "outcome": "done" | "nothing" | "failed" | "cancelled",
  "summary": "uma frase", "error": "o motivo da falha", "session": "…",
  "usage": { "input": 0, "output": 0, "cached": 0, "cost": 0 },
  // o que segue é o recibo, aplicado de uma vez em uma única transação
  "ask":     [{ "title", "text", "options": ["…", "…"], "recommend": 0, "about": "recado para si mesmo na continuação", "key": "nome fixo desta questão" }],
  "notice":  [{ "title", "text", "key", "fyi": true }],
  "resolve": [{ "card": 3, "reason": "onde foi verificado que está resolvido" }],
  "later":   [{ "key": "…", "at": "2026-11-05T09:00:00+08:00", "about": "o que verificar na hora" }, { "key": "…", "cancel": true }],
  "events":  [{ "id", "type", "subject", "summary", "detail", "link" }]
}
```

- O resultado pode ser reproduzido: se a resposta se perder, envie o mesmo conteúdo de novo com o mesmo token e receberá a mesma confirmação; conteúdo diferente devolve 409.
- `failed` gera nova expedição, então só carrega `notice`; o resto não tem efeito. Na rodada que o titular quer interromper, enviar `failed` não gera nova expedição e o `notice` também não tem efeito.
- Quando é preciso que o titular restabeleça conexão, login ou autenticação, termine a rodada com `done` e entregue um `ask`, não `failed`. `done` indica que a rodada terminou e que o assunto não concluído continua sendo acompanhado pelo cartão; não significa que a página foi aceita. Se já existe um cartão `open` para o mesmo bloqueio, não repita a pergunta nem use `later` para novas tentativas agendadas; cancele com `cancel` as reverificações do mesmo bloqueio que já estiverem em `waiting`. Preserve o trabalho já concluído e escreva em `about` exatamente quais etapas restantes devem ser feitas após a recuperação.
- `usage` é reportado pelo worker com o consumo desta execução, incluindo a reescrita do recibo desta execução; cada item pode estar ausente: `input`, `output` e `cached` são contagens de tokens e `cost` é em dólares. `input` é toda a entrada, incluindo o que foi lido do cache e o que foi gravado nele; `cached` é a parte lida do cache, cujo preço costuma ser uma fração, por isso vem separado. A central soma os valores reportados das execuções da mesma rodada, e envios duplicados não são cobrados duas vezes; campos não reportados permanecem ausentes, sem serem tratados como zero. `agent-autoloop status` agrega pelo horário de conclusão as rodadas encerradas de hoje e dos últimos 7 dias e informa com sinceridade quantas rodadas não reportaram.
- Alguns Agents só fornecem valores acumulados da sessão (tokens no Codex, custo no Claude Code). O worker subtrai o acumulado anterior a esta inicialização antes de reportar, então aqui vem sempre o valor desta execução; retomadas sem registro não reportam esses itens. Veja [Documentação de plugins](plugins.md#plugin-de-agent).
- O escopo do `key` de `ask` é o assunto: se o cartão com o mesmo `key` ainda estiver aberto, não é enviado de novo. Perguntar depois de fechado conta como uma nova vez.
- `notice` aceita o campo booleano opcional `fyi`: `true` significa “apenas informativo”, o cartão já nasce `closed`, ainda assim é entregue dentro de 24 horas após a criação, aparece no Feishu como cartão cinza, sem o botão “Resolvido”, não entra no `open` das rodadas seguintes e clicar nele não gera evento de resposta. Quando omitido ou `false`, a notificação traz o botão “Resolvido” e pode ser encerrada por `resolve`. Como já nasce encerrada, escrever o mesmo `key` na rodada seguinte envia outro cartão; em novas tentativas da mesma rodada, envia uma única vez. Com `tell: "never"` na regra, também não é enviada. Centrais antigas não conhecem este campo e rejeitam o recibo inteiro: quando central e worker são implantados separadamente, atualize primeiro a central.
- `resolve` só pode encerrar cartões da mesma fonte e do mesmo grupo que já existiam antes desta rodada pegar o trabalho; o que estiver fora disso vai para `rejected`, sem afetar o resultado da rodada.
- O escopo do `key` de `later` é o assunto; escrever o mesmo `key` de novo apenas altera o horário.
- A fonte de `events` é determinada pelo `emits` da regra; o recibo não pode alterá-la.

### O Agent só precisa fazer uma coisa

O worker entrega o prompt ao Agent, e a última mensagem do Agent é o recibo:

````
Primeira linha: uma frase de conclusão. Falha temporária com nova tentativa automática: escreva “FALHOU: motivo”. Bloqueio que exige recuperação pelo titular: escreva “AGUARDANDO VOCÊ: motivo” e entregue ask. Nada havia para fazer: escreva “NADA A FAZER: motivo”. Fora isso, encerre a rodada; o assunto continua sendo acompanhado pelo recibo.

```agent-autoloop
{ "ask": [ … ], "notice": [ … ], "resolve": [ … ], "later": [ … ], "events": [ … ] }
```
````

O bloco de código é opcional. Quando não há bloco `agent-autoloop` mas o último bloco `json` contém apenas campos de recibo, considera-se que o recibo foi marcado errado e ele é reescrito conforme abaixo; blocos `json` comuns não são afetados. O Agent não precisa instalar nada nem se conectar à central, então Agents em sandbox ou na nuvem também podem ser integrados.

Recibo escrito errado não refaz o trabalho: o worker retoma a sessão original e pede apenas que a última mensagem seja reescrita, no máximo duas vezes; Agents sem sessão (como `command`) não passam por reescrita e seguem direto para a frase seguinte. Se ainda assim não for compreensível, ou se o processo de reescrita falhar ao iniciar, der erro, estourar o tempo ou não produzir saída, mantém-se o desfecho da primeira linha da mensagem de trabalho original, o recibo é descartado e um cartão é enviado dizendo onde está o texto original (a saída de cada rodada é mantida por 14 dias após o fim da rodada). Falhar ao completar o recibo não transforma trabalho já concluído em nova tentativa automática.

### Conectar um novo Agent

Uma linha na regra; serve qualquer comando capaz de imprimir uma última mensagem, e código de saída diferente de 0 conta como falha:

```json
{ "name": "Hermes", "worker": "mac-mini", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
```

Para ter continuação de sessão, link para abrir a sessão e estatísticas de uso, escreva um arquivo em `plugins/<nome>/agent.ts` (veja `plugins/claude/agent.ts`):

```ts
export default {
  command: (run) => [...],                                         // a linha de comando desta rodada; run.resume é a sessão a retomar
  read: (output) => ({ text, session, usage, finished, started }), // extrai da saída a última mensagem e a sessão
  link: (session) => "…",                                          // opcional: link para abrir esta sessão
};
```

`started` indica que o Agent recebeu o prompt desta rodada e deve estar presente seja qual for o desfecho — conclusão, erro ou processo desaparecido. Com ele, um erro posterior nesta rodada conta como falha: permanece na sessão original para a central reexpedir. Sem ele, falhas ao retomar a sessão antiga são tratadas como incapacidade de retomar, e uma sessão nova é aberta para rodar o prompt outra vez. `finished` indica que a rodada realmente terminou; se não encerrar em 30 segundos, é interrompida. Não vale quando tarefas em segundo plano ainda não terminaram e o Agent pretende voltar para continuar.

Os três níveis de `access` dos plugins dedicados são traduzidos para as permissões do CLI correspondente: `read` somente leitura, `edit` altera apenas o diretório de trabalho (padrão), `full` permissão completa, sem aprovação. Somente leitura não significa não conseguir ler chaves; para isolar chaves use contas de sistema ou contêineres. `command` apenas passa argumentos de comando e não restringe permissões de programas arbitrários.

O navegador é fornecido pelo ambiente de execução do Agent. O Codex usa `codex exec` em segundo plano, então não se pode presumir que a conexão de navegador do aplicativo de desktop esteja automaticamente disponível; use as ferramentas de navegador de fato disponíveis naquela rodada ou a entrada configurada explicitamente pela regra ou pela Skill. A entrada trata apenas das etapas web e continua a própria sessão; o trabalho e o recibo continuam sob responsabilidade da tarefa principal. A central não traz ponte de navegador, não instala nem autoriza ferramentas de navegador; a aceitação da integração está em [Documentação de plugins](plugins.md#acesso-ao-navegador).

## Canais: levar o cartão até você

Um canal é um programinha que se conecta para fora.

```
GET /v1/cards/next?wait=50    Authorization: Bearer <chave do canal>
→ 200 { "card": null | Card }

// Card: o estado atual deste cartão. O conteúdo não muda depois da criação; só o estado muda
{ "id": 56, "version": 2, "ref": null, "kind": "ask", "state": "open",
  "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0,
  "choice": null, "answer": null, "by": null, "result": null, "link": null, "rule": "…" }
```

- `rule` é o nome da regra ou da tarefa agendada em outro lugar que criou este cartão, e pode não existir (por exemplo, alertas da própria central, cujo título já diz de onde vem). Cartões vêm de muitos lugares; os canais embutidos de Feishu, desktop e Webhook, a página de cartões e o `agent-autoloop status` indicam “Fonte: <rule>”, sem repetir quando o título já é esse nome. Canais escritos por você devem seguir o mesmo padrão.
- Com `ref` vazio, envie uma mensagem nova; com `ref` preenchido, altere aquela mensagem para o estado atual e, se não der para alterar, apenas reporte.
- Depois de enviar, reporte: `POST /v1/cards/56/delivered { "version": 2, "ref": "om_xxx" }`. O que não for reportado volta para você depois de um minuto. **Em plataformas com chave de idempotência, a mensagem nova usa apenas o número do cartão, sem versão** (quando o Feishu não consegue alterar um cartão já encerrado, envia outra mensagem, e só essa leva versão). Sem suporte da plataforma não há como garantir deduplicação, e os modelos de Webhook podem reenviar depois de um relatório perdido.
- Se não conseguir enviar: `POST /v1/cards/56/failed { "version": 2, "error": "…" }`. A primeira entrega é repetida com intervalos crescentes e desiste depois de uma hora (o cartão continua aberto e visível em `agent-autoloop status`); um canal que nunca vem buscar não conta.
- Cartões resolvidos antes da entrega não incomodam mais você; notificações apenas informativas `fyi` ainda podem ser entregues dentro de 24 horas após a criação.
- Quando você clica: `POST /v1/cards/56/answer { "choice": 1, "by": "ou_xxx", "ref": "om_xxx" }`. Só a primeira resposta vale; `by` precisa estar no `answerers` deste canal e `ref` precisa ser o da mensagem entregue. Notificações comuns têm um botão “Resolvido” que encerra ao ser clicado; também é possível enviar `text` com uma explicação do tratamento, guardada no `answer` do cartão no encerramento e visível tanto no cartão quanto em `/v1/state`. Notificações apenas informativas `fyi` não têm botão.

O menor canal leva umas quinze linhas: pegar cartões, enviar texto e `link`, reportar. `link` só vem para canais configurados com `"links": true`; nos demais é `null`. Ele abre uma página de formulário comum, sem scripts, com o texto e os botões deste cartão; quem tiver o link pode responder. Vale por 7 dias a partir da criação do cartão e, expirado, também deixa de mostrar o conteúdo — serve para bots de grupo e e-mail que só enviam texto. Canais capazes de enviar botões e receber callbacks (como o Feishu) usam botões, com a identidade verificada pela plataforma, o que é mais seguro. No uso em um único computador, `link` é um endereço local e o celular não consegue abrir; para aprovar pelo celular, coloque a central em uma máquina com endereço público e configure `publicUrl`.

## O titular: visão geral, respostas, encerramento e parada

```
GET  /v1/state              Authorization: Bearer <chave do titular>
→ 200 { "seq", "totals", "cards", "recentCards", "agents", "channels", "sources", "lines", "pauses", "skipped", "elsewhere", "runs", "nextBefore", "hasMore", "unrouted", "spending", "timers", "now", "timezone" }

POST /v1/cards/56/answer    { "choice": 1 } ou { "text": "outra ideia" }
POST /v1/cards/56/resolve   { "reason": "Não precisa mais decidir, porque……" }
POST /v1/runs/12/cancel     {}
```

`agent-autoloop status`, `answer`, `resolve` e `stop` são exatamente estas requisições.

O estado inteiro é lido em um único snapshot, e `seq` é o número de sequência do log naquele instante: para montar seu próprio painel, primeiro busque o estado e depois continue lendo de `GET /v1/stream?after=<seq>`, sem perdas nem repetições. Aqui, `cards` e `recentCards` trazem dois campos a mais: `lane` é o assunto em que o cartão está (o objeto do evento nas regras com `parallel`, string vazia nas demais) e `about` é a observação deixada na pergunta para a rodada que continuaria. Canais e a página de cartões não recebem esses dois campos. Clientes antigos podem ignorá-los.

`GET /healthz` não exige chave e devolve `{ "ok": true, "commit": "<versão em execução na central>" }`; `doctor`, o estado do serviço e a verificação de conformidade o usam para saber se a central está Online.

### Pausar, retomar, reexecutar e rodar agora

```
POST /v1/rules/feedback/pause      { "reason": "o downstream está em manutenção", "until": "2026-11-07T09:00:00+08:00" }   ambos os campos são opcionais
→ 200 { "changed": true, "rule": "feedback", "paused": { "by": "owner", "reason": "o downstream está em manutenção", "since": "…", "until": "…",
        "skipped": { "count": 0, "events": [] } } }
POST /v1/rules/feedback/resume     {}
→ 200 { "changed": true, "rule": "feedback", "paused": { "by": "owner", "reason": "o downstream está em manutenção", "since": "2026-11-06T08:59:12.345Z", "until": null,
        "skipped": { "count": 2, "events": [{ "id": 412, "source": "app", "type": "feedback.new", "subject": "#99",
                                              "summary": "…", "receivedAt": "…", "rules": ["feedback"] }, …] } } }
POST /v1/rules/feedback/replay     { "since": "2026-11-06T08:59:12.345Z" }
→ 200 { "events": [411, 412], "runs": [41, 42] }
POST /v1/rules/inspecao/run        { "subject": "#12", "reason": "dar uma olhada" }                                        ambos os campos são opcionais
→ 200 { "event": 88, "run": 41 }
```

Aceita apenas a chave do titular. O nome da regra vai no caminho com codificação URL e o corpo pode ser vazio; campos desconhecidos devolvem 400. Regra inexistente devolve 404 `Não existe esta regra: <nome>`; tarefas em `elsewhere` devolvem 400, porque a central não as inicia.

Pausar, retomar e reexecutar são fatos no log (tipos `pauseRule`, `resumeRule`, `replayRule`) e não alteram o `rules.json`; continuam valendo após reinicialização e após reconstruir a projeção a partir do log. `by` é o nome da chave de titular usada. Pausar de novo apenas atualiza o motivo e o `until`, mantendo o `since` da primeira vez; quando nem motivo nem `until` mudam, `changed` é false e nenhum fato é acrescentado. `until` deve trazer fuso horário e ser posterior ao agora; ao chegar esse horário, a central retoma automaticamente e registra um fato `tick`.

Uma regra removida do `rules.json` enquanto pausada ainda pode ser retomada.

Durante a pausa:

- **Regras agendadas**: o horário é simplesmente pulado, sem registrar evento nem acumular. `lines[].skippedAt` é o momento do pulo mais recente. Depois de retomar (manualmente ou ao chegar o `until`), os horários perdidos durante a pausa não são repostos; o próximo horário a partir do momento da retomada roda normalmente, inclusive se a central dormiu durante a pausa.
- **Regras de eventos**: os eventos continuam sendo registrados, mas aquela regra não os aceita, não despacha trabalho nem os enfileira esperando a retomada; depois de retomar não há reposição automática. O `paused` do evento guarda as regras que não o aceitaram por causa da pausa, a resposta de `/v1/events` ganha uma lista `paused` e `routed` lista apenas as regras que realmente o aceitaram. Os 20 eventos mais recentes nesse estado estão no `skipped` de `/v1/state`. Esses eventos não contam como “Eventos sem regra”. As outras regras que casam com o mesmo evento continuam aceitando normalmente. A reposição não é automática porque a pausa geralmente acontece quando o downstream quebrou ou é preciso estancar perdas, e uma enxurrada de trabalho chegando de uma vez depois é mais difícil de arrumar do que o que foi perdido; cabe ao titular decidir, depois de olhar, se repõe — veja a reexecução abaixo.
- **Rodadas já na fila, aguardando nova tentativa, ou que receberam resposta ou reverificação vencida durante a pausa**: ficam na fila sem serem despachadas e são pegas normalmente após a retomada, sem perder respostas. As rodadas já em execução não são afetadas; para interrompê-las use `stop`.

`paused.skipped` são os eventos que esta regra pulou desde o início desta pausa (`since`) e que ainda não foram reexecutados: `count` é o total e `events` são os 20 mais recentes, do mais novo para o mais velho. Cada item traz, como no `skipped` de `/v1/state`, `id`, `source`, `type`, `subject`, `summary`, `receivedAt` e `rules`, as regras que não o aceitaram por causa da pausa no recebimento (registrado no momento do recebimento; continua listado mesmo que alguma regra já o tenha reexecutado). Com mais de 20 itens, apenas 20 são listados e `count` diz quantos faltam. Regras agendadas não registram eventos durante a pausa, então `skipped` é `null`. Na resposta de pausa vem o que foi pulado até aquele momento; a resposta de retomada traz `paused` a mais, que é a pausa recém-desfeita, com `skipped` lido depois do desfazimento — contém tudo o que esta pausa pulou e não cresce mais depois disso.

A reexecução entrega esses eventos à regra exatamente como estão, como se tivessem sido aceitos na hora: se houver uma rodada na fila para o mesmo assunto, são incorporados a ela; com `parallel` definido, os assuntos são divididos pelo `subject` do evento; e o Agent recebe a fonte, o tipo, o objeto, o resumo, os detalhes e o link originais. `since` é obrigatório e deve trazer fuso horário; são repostos todos os eventos que esta regra pulou durante a pausa a partir desse horário e que ainda não foram reexecutados — o `paused.since` da resposta de retomada é o desta pausa. O evento em si não muda: `paused` e `routed` continuam registrando quem o aceitou no recebimento e quem não aceitou por causa da pausa. A reexecução apenas o liga a uma rodada desta regra: o `runs` de `GET /v1/events/<número>` ganha essa rodada e a linha do tempo do `why` ganha uma linha “o titular reexecutou eventos pulados durante a pausa”. Quando a incorporação acontece em uma rodada que já estava na fila (aguardando nova tentativa, grupo cheio ou worker Offline), aquele `why` não mostra este evento nem essa linha. Um evento já aceito por alguma rodada desta regra não conta mais como pendente, então cada evento é reposto uma única vez: reexecutar o mesmo intervalo de novo devolve lista vazia e `paused.skipped` deixa de contá-lo. O `skipped` do nível superior registra a situação no recebimento, e os já repostos continuam lá. Quando o mesmo evento também foi pulado pela pausa de outra regra, aquela regra ainda o deve e cada uma pode repor após a retomada. **Regras pausadas não podem ser reexecutadas**: devolve 409 `A regra “…” está pausada; retome antes de reexecutar`. Regras agendadas devolvem 400. Quando uma pausa com `until` é retomada automaticamente no horário, ninguém vê a resposta: a linha de comando já fornece o comando de reexecução no momento da pausa, e durante a pausa o `status` também lista a contagem e esse comando.

Rodar agora segue o despacho normal: registra um evento `run.manual` (a fonte é `schedule` nas regras agendadas e o `when.source` delas nas regras de eventos), com `summary` sendo “<nome da chave> executou manualmente” e `detail` sendo o `reason`; o `subject` determina o assunto nas regras com `parallel`. Se já houver uma rodada na fila para o mesmo assunto, é incorporada a ela e a espera de nova tentativa é cancelada. O `runs[].manual` dessa rodada é true. **Regras pausadas não podem ser executadas agora**: devolve 409 `A regra “…” está pausada; retome antes de executar manualmente`. Pausada significa que aquela regra não despacha nenhum trabalho, e a execução manual não é exceção — assim, a promessa “pausou, não gasta mais dinheiro nem age para fora” não tem exceção. Para uma execução de teste, retome primeiro e então execute.

Em `/v1/state`, cada regra (`lines[]`) ganha `paused` (a pausa em vigor: `by`, `reason`, `since`, `until`, `skipped`; `null` quando não há pausa) e `skippedAt`; o nível superior ganha `pauses` (todas as pausas em vigor, cada uma com o nome da regra em `name`) e `skipped`. Clientes antigos podem ignorar esses campos.

Linha de comando: `agent-autoloop pause <regra> [--reason motivo] [--until horário]`, `resume <regra>`, `replay <regra> --since <horário>`, `run <regra> [--subject objeto] [--reason observação]`. `pause` explica que eventos durante a pausa não são enfileirados e serão listados na retomada; `resume` lista os eventos pulados por esta pausa (no máximo 20, informando o total quando houver mais) e fornece o comando `replay` para repor esse intervalo; `status` lista as regras Pausadas, desde quando, quantos eventos pularam e os 5 mais recentes. Eventos pulados anteriormente por regras já retomadas não aparecem mais no `status`.

`agent-autoloop check [arquivo]` apenas lê o arquivo e valida as regras, sem abrir o banco de dados da central e sem carregar o arquivo nela; sem nome de arquivo, verifica o `rules.json`. Dá para validar um rascunho antes de trocá-lo. `/v1/state` entrega as 60 rodadas mais recentes por vez e `?before=<nextBefore>` pagina para as anteriores. `agent-autoloop runs [regra] [--before <nº da rodada>]` pagina assim para trás, listando 20 rodadas concluídas por vez; ao olhar uma única regra, a filtragem acontece no lado da linha de comando e o protocolo não muda.

`spending.today` e `spending.week` de `/v1/state` independem da paginação e agregam pelo horário de conclusão, considerando o dia de hoje no fuso da regra e as 7 × 24 horas anteriores. Cada item contém `rounds`, `tokens`, `cached`, `cost`, `missingTokens` e `missingCost`: `tokens` é entrada mais saída, `cached` é a parte lida do cache e os dois últimos são quantas rodadas não reportaram o consumo correspondente. Rodadas canceladas antes de começar não contam.

A primeira página também devolve os `timers` que ainda não venceram, cada um com `rule`, `lane`, `key`, `about` e `at`; em páginas de histórico esse campo vem vazio. Clientes do titular podem usar isso para distinguir assuntos em espera normal de reverificação daqueles que já não têm próxima ação.

Instalar e desinstalar não altera o protocolo HTTP. `agent-autoloop --version` mostra a versão e o commit; `agent-autoloop uninstall`, após confirmação, remove os próprios programas, links e serviços, sempre preservando regras, chaves e registros; `--yes` apenas pula a confirmação.

## O que acontece em caso de falha

| O que aconteceu                                              | O que acontece                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fonte enviou o mesmo evento duas vezes                     | É registrado uma única vez                                                                                                                                                                                                                                                                                                                  |
| A resposta do pedido de trabalho se perdeu                   | O mesmo `claim` recupera o mesmo trabalho                                                                                                                                                                                                                                                                                                   |
| A resposta da entrega de resultado se perdeu                 | A reprodução devolve a mesma confirmação                                                                                                                                                                                                                                                                                                    |
| O Agent falhou                                               | Nova expedição depois de 5 minutos, dobrando a cada vez, até no máximo 1 hora; eventos do mesmo assunto que chegam nesse intervalo são incorporados à rodada; você é avisado na 3ª vez consecutiva; na 10ª vez consecutiva não há mais nova tentativa, a rodada é marcada como `cancelled` e um cartão de notificação é enviado — eventos novos que chegam enquanto está em execução contam como outra rodada; quando a rodada termina ou é interrompida, os cartões que diziam que haveria nova tentativa são fechados junto |
| É preciso que o titular restabeleça conexão do navegador, login ou verificação | A rodada termina, o trabalho concluído e os itens pendentes de aceitação são preservados, um cartão de pergunta aguarda a resposta e não há nova expedição automática                                                                                                                                                                        |
| Não deu para retomar a sessão original                       | Abre-se uma sessão nova e continua-se pelos arquivos de material de referência                                                                                                                                                                                                                                                              |
| Retomou a sessão original e caiu no meio                     | Conta como falha, permanece na sessão original e é reexpedida no ritmo acima, sem abrir sessão nova para refazer o trabalho                                                                                                                                                                                                                  |
| Recibo escrito errado                                        | Só o recibo é reescrito, o trabalho não é refeito; Agents sem sessão têm o recibo descartado e um cartão é enviado                                                                                                                                                                                                                          |
| O plugin de Agent não entende a própria saída                | Se ainda estiver rodando, continua; depois de encerrar ou de o processo sumir, conta como falha e permanece na sessão original para nova expedição                                                                                                                                                                                          |
| O worker ou o canal parou, ou um plugin teve erro não tratado | Registrado em log; o que parou é reiniciado depois de 30 segundos; a central e o resto seguem normais                                                                                                                                                                                                                                       |
| Outro processo segurou o banco de dados tempo demais         | Este vencimento não é atendido agora, tenta de novo em 5 segundos e a central não sai; se um arquivo de regra for corrompido por escrita nesse período, você também é avisado                                                                                                                                                               |
| Não foi possível gravar o log (pipe de saída rompido, disco cheio) | O processo encerra e o serviço do sistema o reinicia                                                                                                                                                                                                                                                                                   |
| O worker reiniciou                                           | Os Agents em execução não são afetados; ele volta a acompanhar                                                                                                                                                                                                                                                                              |
| O worker está Online, mas não reportou uma das rodadas em mãos por 5 minutos | Marcada como “Incerto”, o grupo é liberado e você é avisado; o resultado entregue depois continua sendo aceito                                                                                                                                                                                                                              |
| O worker inteiro desapareceu                                 | O trabalho fica guardado sem ser liberado e você é avisado uma vez depois de 10 minutos; após fechar o cartão, esses trabalhos não geram mais lembretes — só fala de novo quando houver trabalho novo. Ao voltar, os cartões são encerrados automaticamente; se sumir de novo, você é avisado de novo                                        |
| A central reiniciou                                          | Está tudo no SQLite; todos se reconectam automaticamente                                                                                                                                                                                                                                                                                    |
| Um agendamento foi perdido                                   | Ao acordar, repõe apenas a ocorrência mais recente                                                                                                                                                                                                                                                                                          |
| Você clicou duas vezes, ou os dois lados clicaram ao mesmo tempo | Só a primeira vez conta                                                                                                                                                                                                                                                                                                                 |
| Depois da pergunta, o problema se resolveu sozinho           | O Agent seguinte verifica e encerra em `resolve`; o cartão muda automaticamente para “não precisa mais decidir”                                                                                                                                                                                                                           |
| A regra foi escrita errado                                   | As regras antigas continuam rodando e você é avisado sobre onde está o erro                                                                                                                                                                                                                                                                 |
| A regra foi removida ou renomeada                            | As rodadas ainda não pegas e as que falharem depois são marcadas como `cancelled`, não são mais despachadas e um cartão de notificação é enviado; as que já estavam em execução terminam e o resultado é aceito normalmente                                                                                                                  |
| A regra foi pausada                                          | Horários são pulados e eventos não são aceitos, sem acumular; o que está na fila fica guardado; após a retomada não há reexecução automática, e as agendadas rodam normalmente a partir do próximo horário; na retomada os eventos pulados são listados e `replay` os repõe, cada um uma única vez                                            |
| A pausa tinha `until` e a central não estava ligada naquele horário | Retoma ao acordar; os horários durante a pausa não são repostos                                                                                                                                                                                                                                                                       |
| O arquivo de regras foi apagado, movido ou não pode ser lido | As regras antigas continuam rodando e você é avisado uma vez; ao colocá-lo de volta, volta a ser usado. Uma central nova que nunca carregou regras não inicia se não conseguir ler                                                                                                                                                          |

É um sistema “pelo menos uma vez”: o Agent pode ser chamado duas vezes, então ações com efeitos colaterais na Skill devem primeiro verificar o estado atual.

## Quem pode fazer o quê

| Credencial                 | Pode                                                                        | Não pode                                              |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Chave de fonte             | Enviar eventos e mensagens em nome próprio e consultar o que aconteceu com os eventos que enviou | Se passar por outra fonte, ver eventos de outras fontes, pegar trabalho |
| Chave de worker            | Pegar o trabalho atribuído a ele; enviar mensagens e perguntas em nome das tarefas `elsewhere` que lhe foram atribuídas | Mexer no trabalho dos outros, emitir eventos |
| Token de uma rodada        | Reportar esta execução desta rodada                                          | Mexer em outras rodadas                                 |
| Chave de canal             | Pegar cartões, reportar e transmitir as respostas dos `answerers`            | Todo o resto                                            |
| Link de cartão com permissão | Responder àquele cartão                                                    | Todo o resto                                            |
| Chave do titular           | Ver tudo, responder, encerrar, parar, pausar, retomar, reexecutar e executar regras agora | Emitir eventos, pegar trabalho, alterar regras (regras só existem em arquivo) |

Chaves de acesso comuns guardam apenas o SHA-256; a chave mestra local fica em `master.key`, separada. O worker não coloca chaves da central no prompt nem nos arquivos de material de referência do Agent; o alcance do acesso ao sistema de arquivos é determinado pelas permissões do Agent.

## Log e determinismo

Cada entrada aceita produz um lote de fatos; entradas que não mudaram nada (eventos duplicados, heartbeat a menos de um minuto do anterior) não produzem. O `commit` realiza a decisão, acrescenta ao log e faz o `evolve` atualizar as views, tudo na mesma transação SQLite WAL + FULL, e só responde depois que o commit termina. Versões de regra, hashes de chave, chamadas de trabalho, recibos e respostas estão no log; o log nunca guarda tokens de rodada, tokens de link de cartão nem a chave mestra da central. A chave mestra é mantida pelo host em um arquivo local, e o token da rodada e o link do cartão são derivados separadamente por HMAC. Um claim repetido emite um token novo e invalida o anterior imediatamente.

`decide(view, input, now, environment)` não altera a view nem a entrada recebidas. `evolve(view, facts)` é o único escritor da projeção persistente; relógio, arquivo de regras, material aleatório, rede e o temporizador único são fornecidos pelo host. Os fatos contêm versão, número de sequência, horário, tipo e as mudanças de registro normalizadas; reproduzir não reexecuta as regras. As views são lidas sob demanda por índices SQLite; uma decisão mantém apenas as mudanças daquela vez, sem copiar tabelas inteiras nem manter todo o histórico residente em JavaScript. A linha das regras é a maior e toda rodada na fila precisa consultá-la, então cada view só a analisa uma vez; com fatos novos há uma view nova, sem risco de ler regras antigas. Log, projeção, cursor do log, marca d'água alta dos números e índices derivados são commitados juntos; registros apagados não têm seus números reutilizados. A inicialização normal abre direto a projeção. O host calcula uma impressão digital de formato a partir dos arquivos que determinam o conteúdo armazenado (`kernel/evolve.ts`, `kernel/credentials.ts`) e da chave mestra; mudanças em outros arquivos não contam, e as views de consulta são reconstruídas a cada inicialização. Quando uma versão antiga não tem cursor ou a impressão não confere, o log é lido registro a registro na mesma transação para reconstruir projeção e índices, sem poder sobrescrever commits novos feitos nesse intervalo e sem carregar o log inteiro na memória de uma vez. A primeira atualização pode exigir espera pela reconstrução; fatos antigos não são alterados e não há migração de dados. As simulações usam o mesmo conjunto de projeção e decisão, com o banco em memória.

A camada de conversão de requisições do Node apenas transforma a requisição do Node em Request; arquivos, conexões SQLite, escuta e temporizadores também são fornecidos pelo host.

`GET /v1/stream?after=42` aceita apenas a chave do titular e devolve SSE: `id` é o número de sequência do log, `event: fact` e `data` é o JSON do fato. Após queda, continua do seguinte com `Last-Event-ID` ou `after`; ler tudo a partir do 0 envia registro a registro na velocidade de leitura do assinante, sem armazenar em cache todo o log antecipadamente. Hashes de chave e credenciais de capacidade nunca são enviados ao assinante.

`GET /v1/runs/42/why` aceita apenas a chave do titular e devolve os fatos relacionados aos eventos da rodada, à versão da regra em cada execução, à chamada de trabalho, ao recibo e às respostas de cartão. A linha de comando `agent-autoloop why 42` usa a mesma interface, com horários exibidos no fuso local como `MM-DD HH:mm:ss`, e por padrão mostra a linha do tempo de eventos, versões de regra, quem pegou, horários de início e fim, sessão, recibo, respostas e rodadas seguintes, sem imprimir o corpo da regra; `agent-autoloop why 42 --json` devolve os fatos brutos. Respostas internas e eventos agendados que encontram um número já existente recebem um sufixo sequencial, mantendo fonte e número únicos e sem sobrescrever os eventos da fonte.

## Conformidade e reprodução

As entradas de plugin são unificadas em `plugins/<nome>/agent.ts`, `channel.ts` ou `source.ts`, procuradas primeiro no diretório de instalação e depois no diretório embutido do motor. `agent-autoloop add <endereço git>` clona o repositório do plugin para `plugins/<nome do repositório>` no diretório de instalação, com o arquivo de entrada direto na raiz do repositório; não há atualização automática nem execução de scripts de instalação. O nome do diretório é o nome do plugin: o nome do repositório é convertido para minúsculas e só pode usar letras minúsculas, números e `-`; o que não atender será rejeitado. Plugins são código confiável instalado pelo titular, e eventos não podem especificar caminho de plugin.

Eventos aceitam `hops` opcional, inteiro seguro não negativo, com padrão 0. Eventos de recibo usam obrigatoriamente o maior hops de todos os eventos da rodada mais 1; respostas a perguntas e agendamentos `later` continuam a profundidade original. Eventos acima de 8 continuam sendo registrados, mas não são despachados e geram notificação; envios duplicados não geram notificação duplicada. É um limite das cadeias de processamento dentro da central: eventos novos emitidos diretamente por fontes externas podem começar em 0. Logs antigos sem hops são lidos como 0.

`DELETE /v1/keys/<source|worker|channel|owner>/<nome>` aceita apenas a chave do titular; o nome é passado com codificação URL e a resposta é `{ok:true, changed}`: quando a chave a remover já não existe, `changed` é false e nenhum fato é acrescentado. `agent-autoloop key remove <tipo> <nome>` chama a central em execução; a remoção acorda e rejeita imediatamente os long pollings daquela chave e fecha as assinaturas do log. Rodadas já pegas continuam entregando resultados com o token de rodada próprio.

`protocol/schema.json` usa JSON Schema 2020-12 e define os formatos de eventos, recibos, tarefas, cartões e log. `agent-autoloop conformance <endereço de teste> --config <arquivo>` usa HTTP de verdade; o arquivo contém `keys` (as quatro chaves de teste source, worker, channel e owner), um `eventType` que case com a regra de teste e um `answerer` permitido pelo canal. A regra deve entregar aquela fonte e tipo àquele worker, `parallel` deve ser no mínimo 2 e o canal deve restringir quem pode responder. A verificação grava eventos e cartões, então rode apenas em uma central de teste dedicada; a mesma central de teste pode ser verificada repetidamente. O formato de assinatura de cada fonte é verificado pelos testes do plugin correspondente.

Os limites de texto são contados em code points Unicode: o `text` da resposta de cartão aceita no máximo 4000 caracteres, `by` no máximo 500 e `ref` no máximo 500, e o número de mensagem reportado pelo canal aceita no máximo 500 caracteres. `usage` deve ser um objeto com valores numéricos não negativos e finitos, nunca um array; `later.at` deve ser um ISO datetime de uma data real, com `Z` ou deslocamento de fuso. O recibo é validado por inteiro antes de ser executado.

`npm test` inclui uma simulação de 200000 passos com semente 24301, além de todas as 8! ordens de ações com dois workers, dois eventos de fonte e um cartão de pergunta. A simulação troca de cenário independente a cada 128 passos e, antes de terminar cada cenário, interrompe as falhas e conclui o trabalho; cada transição de estado verifica invariantes e a reprodução completa do log. Eventos agendados são disparados pela tabela de vencimentos real, e após a recuperação verifica-se que não sobraram tarefas vencidas. Isso prova esses cenários finitos e não significa que um espaço de estados de tamanho arbitrário tenha sido esgotado. Reprodução isolada: `node sim/random.ts 24301 200000`, `node sim/enumerate.ts`.

`npm run test:nightly` executa 1000 SIGKILL em processos reais, todas as mutações de kernel em `sim/mutate.ts` e as medições de desempenho. Os testes de crash usam SQLite WAL + FULL de verdade e conferem números de sequência confirmados, integridade, views, reprodução e commits duplicados; testam a saída do processo, não simulam queda de energia da máquina inteira. Deixar passar qualquer mutação conta como falha, com o nome impresso diretamente; erro de sintaxe não vale como detecção. O CI roda kill forçado e mutações uma vez por dia, por agendamento; os números de desempenho dependem da máquina e só rodam localmente. `node sim/crash.ts 1000 12648430` e `node sim/mutate.ts` reproduzem cada um separadamente.

As verificações de correção da simulação devem passar; a velocidade da simulação é apenas um indicador observacional de eficiência de desenvolvimento. As medições de desempenho usam gravação HTTP registro a registro, respondendo só depois que a transação chega ao disco. RSS em ocioso e RSS sob carga de mil conexões são medidos separadamente; os números medidos estão no README. Grandes volumes de histórico (resultados em [Crescimento do histórico na prática](#crescimento-do-histórico-na-prática)) são verificados com `node scripts/history.ts 1000 10000 100000`, cobrindo trabalho real, respostas HTTP, assinatura lenta do log, novas tentativas após kill forçado e reconstrução completa; cada cenário contém duas rodadas de trabalho, pergunta, entrega, resposta e reverificação agendada, com commits WAL + FULL individuais. As requisições usam HTTP de verdade, cada tipo de operação e o resumo de estado são medidos 30 vezes e a mediana é usada; memória sob gravação contínua, em ocioso e sob carga de requisições são reportadas separadamente, sem disparar GC manualmente.

O custo com fila profunda é medido separadamente com `BENCH_QUEUE=5000 node scripts/benchmark.ts --busy`: cerca de 4,4 KB de regras, 1000 long pollings esperando, 5000 rodadas na fila (`BENCH_QUEUE` pode ser alterado), reportando p50 e p99 dos heartbeats bloqueados, CPU por heartbeat, quantos fatos foram gravados nesse período e as medianas de recebimento de eventos, chamada de trabalho, entrega de resultado e chamada sem trabalho. `npm run benchmark` também inclui este item.

### ACP e MCP

`use: "acp"` com `command: ["algum programa ACP", "argumentos de inicialização"]` usa ACP v1 por stdio. Um Agent ACP deve definir `command`; sem ele a rodada conta como falha, com o motivo dizendo o que falta. A ponte primeiro inicializa e depois cria uma sessão nova ou retoma a antiga: se o Agent declarar `loadSession`, usa-se `session/load`; se declarar apenas `sessionCapabilities.resume`, usa-se `session/resume`. O histórico reproduzido no carregamento não conta como resposta desta rodada, e raciocínio e saída de ferramentas não entram no recibo. Enviar o prompt já conta como início da rodada; quedas depois disso permanecem na sessão original para nova expedição. Ao retomar a sessão antiga, a vez anterior pode ter ficado pela metade, então só se abre sessão nova quando o Agent rejeita explicitamente aquela sessão (devolveu erro ou não suporta nenhuma das duas formas de retomada); programa que não sobe, erro de inicialização e queda no meio do carregamento permanecem na sessão original para nova expedição. Sessão já aberta por outro programa (o `data.reason` do erro é `thread_active_writer`) também não conta como rejeição: a rodada conta como falha, o motivo é a própria mensagem do Agent, permanece na sessão original para nova expedição depois de um tempo, e o cartão da 3ª vez consecutiva traz essa mensagem dizendo o que você precisa fechar. Todos os outros erros contam como rejeição, sem olhar o código de erro: o adaptador oficial do Codex devolve -32603 para sessões realmente inexistentes. Só conta como concluída a rodada com `end_turn` e uma última mensagem de texto: havendo `messageId`, as mensagens são separadas por ele; sem ele, raciocínio, chamadas de ferramenta e atualizações de ferramenta concluída ou falha contam como divisória. Quando a rodada não conclui, a ponte informa o motivo imediatamente e, se o Agent não sair em 30 segundos, é interrompido junto com o grupo de processos. As mensagens são enquadradas apenas por quebra de linha, e linhas incompreensíveis contam como falha da rodada. O número da sessão é entregue à central para guardar. Sem capacidades declaradas de leitura e escrita de arquivos, terminal ou login interativo, o Agent usa as próprias ferramentas; quando é preciso fazer login, use primeiro a linha de comando dele.

Para permissões só se escolhe a opção de uso único: `read` permite leitura e busca estruturadas, `edit` permite também edição dentro do diretório de trabalho (links simbólicos são conferidos; passar por um link cujo alvo não existe conta como fora do diretório) e `full` permite as demais operações. Quando a requisição de permissão traz apenas o número da chamada de ferramenta, decide-se pelo tipo e caminho informados antes daquela chamada, prevalecendo os campos que a própria requisição trouxer. Não havendo a opção correspondente, cancela-se. As permissões dependem de o Agent cumprir o ACP e não fornecem isolamento adicional de sistema; a especificação permite que o Agent execute sem perguntar, e essas operações o `access` não consegue bloquear — use o modo do próprio Agent para restringir. A única opção de rejeição que o adaptador oficial do Codex oferece é `cancel` (`reject_once`); ao escolhê-la a rodada inteira termina com `stopReason: cancelled`, conta como falha e é reexpedida pela central. É assim que voltam os pedidos de execução de comando nos níveis `read` e `edit`, então, quando o Agent precisa mesmo executar comandos, dê `full` ou use o modo dele. `model`, `effort` e `tier` não têm efeito. Base de conferência: [Inicialização](https://agentclientprotocol.com/protocol/v1/initialization), [Sessão](https://agentclientprotocol.com/protocol/v1/session-setup), [Permissões de ferramentas](https://agentclientprotocol.com/protocol/v1/tool-calls).

`agent-autoloop mcp` fornece MCP por stdio, com suporte fixo à versão [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) e sem suporte ao protocolo sem handshake de 2026-07-28. As ferramentas são `status`, `why`, `answer`, `resolve`, `stop`, `emit`, `tell`, `pause`, `resume`, `replay` e `run`; `status` aceita `before` para paginar rodadas para trás. As ferramentas exibidas dependem das chaves de titular ou de fonte já existentes no computador, e `pause`, `resume`, `replay` e `run` exigem chave de titular, como os comandos de mesmo nome na linha de comando. Ele chama as mesmas interfaces HTTP e não altera o banco diretamente; as chaves ficam no `config.json` local. No cliente MCP, defina o programa como `node` e os argumentos como o caminho absoluto do motor `bin/agent-autoloop.ts` e `mcp`, especificando `AGENT_AUTOLOOP_HOME` no ambiente. A saída padrão escreve apenas JSON-RPC. As mensagens são enquadradas apenas por quebra de linha; cada chamada de ferramenta responde por si e chamadas lentas não bloqueiam `ping`. Ele não distingue quem chama e registra tudo como titular (`answer` é registrado como titular e `emit` não traz número de camadas), então não o configure no perfil de usuário de um CLI iniciado pelo worker, caso contrário uma rodada poderia responder aos próprios cartões.

### Modelos de canal e exemplos de linha de comando

A configuração em `config.json` de um canal Webhook usa `use: "webhook"`, `url` e `platform`, sendo a última opcional entre `dingtalk`, `wecom`, `slack` e `discord`. Sem `platform`, dá para usar um modelo próprio em `body`, onde `{text}` na string é substituído pelo conteúdo do cartão. Os quatro modelos seguem a documentação oficial: [DingTalk](https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type), [WeCom](https://developer.work.weixin.qq.com/document/path/91770), [Slack](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) e [Discord](https://discord.com/developers/docs/resources/webhook#execute-webhook). O WeCom exibe URLs comuns como “Abrir link” e o endereço de encerramento das notificações sem opções como “Clique para tratar”, sem listar à parte “1. Resolvido”; marcadores de link e os sinais de `<` e `>` escritos no cartão são trocados por equivalentes de largura total e exibidos literalmente, para não virarem link, marcação ou menção. DingTalk e WeCom conferem o `errcode` da resposta, o Slack confere `ok`, e o Discord proíbe que texto dispare menções. Cartões que passem de 2048 bytes no WeCom ou 2000 caracteres no Discord são reportados como falha, sem truncar a pergunta nem o link de resposta. O Webhook em si não tem garantia de idempotência, então pode haver reenvio quando a mensagem é enviada com sucesso mas o relatório se perde.

A notificação de desktop `desktop` é o canal ativado por padrão em instalações novas: `osascript` no macOS, `notify-send` no Linux e notificação da bandeja do sistema via PowerShell no Windows. O título da notificação é “O Agent fez uma pergunta a você”; o corpo é o título do cartão, “Fonte: <nome da regra>” (quando o cartão traz regra e o título não é o nome da regra) e “Execute agent-autoloop status para ver”. No Unix, o texto é passado como argumento depois de `--`; no Windows, os dados JSON são codificados e decodificados por um script fixo, sem executar o texto como PowerShell. Sem sessão gráfica, o programa de notificação não é chamado e reporta-se `skipped-<número do cartão>`, sem incomodar repetidamente; o cartão continua podendo ser visto e respondido pela linha de comando. Havendo sessão gráfica mas o comando de notificação não existindo ou falhando, reporta-se `failed` e a central agenda a nova tentativa. Atualizações de cartão apenas reportam, sem repetir o pop-up.

`examples/worker.sh` e `examples/channel.sh` usam apenas comandos embutidos do shell, curl e jq. Defina `AGENT_AUTOLOOP_URL` e `AGENT_AUTOLOOP_KEY` antes de executar; `AGENT_AUTOLOOP_ONCE=1` pega trabalho uma única vez. O exemplo de worker devolve o JSON em `AGENT_AUTOLOOP_RECEIPT`, por padrão devolvendo concluído; o exemplo de canal imprime o cartão no terminal e depois reporta a entrega. São exemplos de tarefas curtas e não servem para tarefas longas; para tarefas longas use o heartbeat, a parada e a recuperação de `worker/`. `tests/examples.test.ts` executa de verdade os dois scripts em uma central temporária que passa na verificação de conformidade do protocolo, cobrindo pergunta, entrega, resposta, continuação e chave errada.

## Receitas de negócio

As receitas que podem ser ativadas diretamente e as instruções de configuração estão no [README](../README.md#receitas-prontas-para-usar).

A fonte de feedback apenas acorda o mesmo assunto; o estado de negócio atual e a autorização são relidos de interfaces confiáveis. A verificação do site usa os cartões de notificação de anomalia não encerrados desta regra como registro de falha: na primeira falha envia notificação e evento de investigação, em falhas contínuas fica em silêncio e, na recuperação, encerra e envia evento de recuperação; se o cartão não recuperado for fechado manualmente e a falha continuar, volta a reportar. A coleta do Feishu escreve um snapshot privado após a leitura completa e emite evento, o resumo confere o número do snapshot e eventos antigos não usam material novo; coleta e resumo ficam em série no mesmo grupo. Só dados legíveis pela identidade do titular entram no resumo, e o que está invisível não é tratado como não enviado.

A receita de transferência de navegador é uma chamada com parâmetros da tarefa principal a uma entrada já instalada, sem driver de navegador. A configuração confiável fixa comando, alvo e operações permitidas, e a continuação usa o número de sessão do Codex realmente devolvido pela entrada; conteúdo de página e eventos externos não podem alterar esses limites. Quando conexão, login ou verificação ficam bloqueados, a tarefa principal faz `ask` e encerra a rodada; depois da resposta só continua as etapas web restantes, sem que o assistente de navegador delegue de novo ou encerre por conta própria.

Os scripts de inspeção e de resumo do Feishu são verificados com HTTP falso local e CLI falso do Feishu, sem chamar dados de negócio reais nem enviar mensagens de verdade. Os exemplos públicos não contêm endereços internos, contas ou registros de negócio; o material substituído pelo usuário não deve ser commitado no repositório.

## Estrutura e medições

O host suporta Windows, macOS e Linux; o kernel não distingue sistema operacional. A instalação no Windows usa `install.ps1`, e a permanência usa uma tarefa agendada após o login do usuário atual, iniciada de forma oculta por wscript e reiniciada 10 segundos depois de sair; cada rodada tem um processo supervisor Node próprio que guarda saída e código de saída, o PowerShell cria um Job Object para controlar os descendentes e, após reiniciar, o worker lê os registros existentes para continuar conferindo. O diretório de dados no Windows usa ACL; no Unix permanecem modo de permissões, shell de login, grupo de processos e launchd/systemd.

Um registro de fatos somente de acréscimo é a origem do estado de negócio; as views podem ser reconstruídas e reproduzir não reexecuta as regras. cron, later, novas tentativas, leases e a verificação de offline compartilham a tabela de vencimentos, e o host só agenda o temporizador do próximo vencimento. Só a entrada que mudou algo e o despertar de um vencimento o recalculam: entradas que não mudaram nada (como um heartbeat bloqueado) não leem a fila nem gravam fatos; as partes que mudam apenas com o tempo têm o próprio horário de vencimento e são recalculadas naturalmente quando o temporizador dispara. A interface é HTTP + JSON; CLI dedicado, MCP, fontes, workers e canais usam o mesmo conjunto de interfaces.

| Diretório                                                  | Responsabilidade                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `kernel/`                                                  | Decisão determinística, evolução, log, vencimentos, casamento de regras, tratamento de requisições e formulários de cartão |
| `host/`                                                    | HTTP do Node, arquivos e conexão SQLite, relógio, configuração, resumo de estado, serviços em segundo plano e carregamento de plugins |
| `protocol/`                                                | Tipos, JSON Schema, validação de entrada, cliente HTTP e verificação de conformidade |
| `worker/`                                                  | Chamada de trabalho, processos de Agent, heartbeat e parada, leitura e envio do recibo |
| `cli/`, `bin/`                                             | Comandos do usuário, MCP e ponto de partida da linha de comando                  |
| `plugins/`                                                 | Plugins de Agent, de eventos, de canal e de entrega, com descoberta unificada de entradas |
| `examples/recipes/`                                        | Regras de receitas completas, Skills de tarefa e instruções de ativação          |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh`   | Plugins mínimos, manuais de tarefa independentes e exemplos com curl/jq          |
| `skills/agent-autoloop/`                                   | Configuração oficial e manual de operação da central, para usuários e Agents     |
| `docs/`                                                    | Protocolo de comunicação, documentação de desenvolvimento de plugins e diagramas de arquitetura |
| `tests/`                                                   | Testes de comportamento do dia a dia e código auxiliar de teste                  |
| `sim/`                                                     | Simulação com semente fixa, enumeração limitada, kill forçado e mutação          |
| `scripts/`, `.github/workflows/`                           | Desempenho e verificação em máquina real, smoke test de instalação e CI multiplataforma |

As receitas prontas e as entradas dos plugins embutidos estão no [README](../README.md#receitas-prontas-para-usar), e os modelos de desenvolvimento em [Escrever plugins](plugins.md). Os nomes de arquivo de plugin continuam usando o `source.ts` do protocolo, que corresponde ao “plugin de eventos” voltado ao usuário.

`npm run benchmark` imprime inicialização a frio, memória em ocioso e com mil conexões, gravação em disco registro a registro, p99 do despacho, p99 dos heartbeats bloqueados com fila profunda e vazão da simulação, sem linha de corte a atingir. Os números estão no README, medidos localmente em um Apple M5 Pro, e não representam capacidade de servidor; não se reduz a leitura mudando o tempo de amostragem nem disparando GC ativamente. O log só acrescenta e não compacta, então o uso de disco continua crescendo com o histórico. A memória residente não guarda todo o histórico, mas trabalho pendente e resultados devolvidos ainda ocupam memória; somar totais ainda exige percorrer os índices do banco. Não há página de visão geral, canvas de workflow, memória de Agent, roteamento de modelo, multilocação nem mercado de plugins.

### Crescimento do histórico na prática

Apple M5 Pro, 24 GB, Node 24.21.0, reproduzido com `node scripts/history.ts 1000 10000 100000`:

| Rodadas de tarefas concluídas (aprox.) | Fatos (aprox.) | Inicialização normal | RSS ocioso | Mediana HTTP de chamada de trabalho | Resumo de estado |
| -------------------------------------- | -------------: | -------------------: | ---------: | ----------------------------------: | ---------------: |
| 2.000                                  |         11.000 |              84,7 ms |    59,1 MB |                             0,89 ms |          11,2 ms |
| 20.000                                 |        110.000 |              83,2 ms |    58,9 MB |                             0,84 ms |          83,6 ms |
| 200.000                                |      1.100.000 |              99,8 ms |    59,1 MB |                             0,82 ms |         927,1 ms |

- Com 1,1 milhão de fatos, a mediana das requisições de recebimento de eventos, deduplicação, entrega de resultado, heartbeat, polling de canal ocioso e `why` é de 0,39–0,69 ms; a recuperação normal após kill forçado do processo leva cerca de 101 ms.
- Memória: pico de cerca de 282 MB durante gravação contínua de histórico; cerca de 75 MB com requisições de negócio mais uma assinatura lenta do log.
- O que cresce com o histórico: o tempo do resumo de estado e o disco ocupado por log e índices.
- A primeira inicialização após mudança de formato reconstrói tudo a partir do log: 1,1 milhão de registros levou 43,1 s, com pico de cerca de 141 MB e dados idênticos antes e depois. Reinicializações comuns não reproduzem.
- Simulação de 200 mil passos (item observacional): 93,8 s, 2131 passos/s.

## Plugin de entrega

A entrega é um processo de Agent comum em `plugins/delivery`; o kernel não a conhece. Os projetos continuam usando `ops/delivery.json`, os rótulos continuam sendo `deliver`, `deliver-attended`, `deliver-review` e `ask-owner`, e o status de commit continua `delivery`. O status de revisão é por padrão `agent-review`, especificado por `review.status` ou pelo `--review-status` do comando de chamada de trabalho. A revisão pode ser configurada por projeto ou, com `--review-policy owner/name:caminho`, ler uma política global da main do mesmo repositório. Formato da configuração, regras e exemplo de Ship estão no [Manual de configuração](../skills/agent-autoloop/SKILL.md#pipeline-de-entrega).

A fonte só fornece eventos; repositório e comandos de execução são fixados pelas regras da central. O `poll.ts` embutido lê os rótulos pendentes e gera números de evento estáveis a partir de “repositório, assunto, registro de rótulo e commit atual”, sem guardar cursor separado; quando não consegue ler o registro de rótulo de um assunto, aquele trecho é registrado como 0, sem afetar os outros. Sem rótulo (inclusive já mesclado), fechado sem merge, fork ou alvo diferente de main, a entrega não é iniciada. Um assunto por PR, com concorrência controlada em conjunto pelo `parallel` do grupo de regras, pelo `maxActive` de cada regra ou Agent e pela capacidade do worker.

| Etapa                       | Deve satisfazer                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leitura da configuração     | Lê a configuração do projeto e os pontos de revisão no commit fixo da main correspondente à revisão desta rodada, não a versão do PR; se a main avançar, uma nova rodada lê de novo                                                                                                                                  |
| Sincronização               | O PR já contém a main; quando falta, pede sincronização ao GitHub e espera dentro da rodada até o commit sincronizado aparecer para continuar, só encerrando a rodada se não aparecer em 15 minutos, para a central tentar de novo                                                                                      |
| Revisão                     | Objetos Git puros viram diff em texto; revisa apenas os commits do próprio branch, excluindo mudanças que entraram limpas na main e mantendo resoluções de conflito; documentação interna comum pode pular o modelo; quando o branch tem um merge octopus com três ou mais commits pai, a revisão não enxerga as mudanças que ele trouxe e reporta o problema diretamente, pedindo para trocar por um merge comum |
| Processo de revisão         | Não faz checkout do PR e não executa o código, os testes, a configuração nem os hooks dele; por padrão o Codex ignora configuração e memória do usuário e lê apenas um snapshot independente                                                                                                                         |
| Revisor                     | Por padrão é o Codex embutido ou `review.command`; mudanças escritas por Agents listados em `review.agents` passam a usar o revisor designado para eles: modelo e profundidade do Codex embutido, um comando, ou dispensa de revisão                                                                                   |
| Verificação completa        | Rascunho vira ready primeiro, registrando antes a verificação mais recente e aceitando apenas as mais novas que ela (o tipo de disparo do workflow deve incluir `ready_for_review`); aceita apenas quando o workflow pull_request mais recente do commit atual e os jobs especificados terminaram todos com sucesso — rascunho ou job skipped não conta; em jobs de matriz (com nome como `check (ubuntu-latest)`) cada item precisa ter sucesso |
| Merge                       | Lê de novo o head do PR, o branch de destino, a main e os rótulos; se o head mudou ou o branch de destino não é mais main, encerra a rodada para a central tentar de novo; se a main avançou, volta à sincronização dentro da rodada, no máximo 3 rodadas; só depois que as verificações passam escreve o status de revisão configurável e faz o merge pelo SHA revisado |
| Auto-merge e respostas perdidas | Primeiro desativa o auto-merge existente e lê de volta para confirmar; se a resposta do merge se perder, verifica primeiro se o merge já aconteceu, sem reenviar às cegas; falha ao limpar rótulos também é confirmada por leitura de volta para saber se já foram removidas; em PRs já mesclados remove por último a `deliver` e, nos não mesclados, remove por último a `deliver-review`; quando só uma parte foi removida, a nova tentativa consegue terminar e não faz merge de PRs que são só revisão |
| Publicação                  | Espera um Ship bem-sucedido que cubra o commit do merge e então confere a versão saudável; HTTP 200 do health não compensa Ship falho ou ainda não concluído                                                                                                                                                          |
| Publicações seguintes       | Uma versão nova que cubra e que de fato tenha ido para produção pode concluir a entrega antiga; entregas já concluídas não regridem por publicações que falharem depois                                                                                                                                                |

Enquanto espera a verificação completa, a execução `pull_request` mais recente do commit atual precisa ser mais nova que o número de verificação registrado antes de virar ready. Se essa execução está em `queued`, `waiting` ou `pending`, a lista completa de jobs está vazia e já se passaram mais de 10 minutos desde `created_at`, considera-se que o GitHub recebeu a verificação e não começou a executar. O plugin passa o PR para rascunho e de volta para ready, uma única autorrecuperação. Antes de voltar a ready, registra de novo o número da execução `pull_request` mais recente, excluindo as verificações disparadas pela ida a rascunho e aceitando apenas execuções novas posteriores. O registro da autorrecuperação é vinculado ao commit e existe em `DeliveryIO.checkRecovery` durante a execução; quando é preciso reverificar, o número da verificação é gravado como `checkAfter` no JSON `about` de um `delivery-retry` já existente, junto com `head` e a contagem de erros, para a rodada seguinte continuar usando, reiniciando a contagem quando o commit muda. Se a execução nova travar nas mesmas condições, informa imediatamente, pelo fluxo de devolução e notificação da entrega, que o GitHub não começou a verificar, sem contar para os cinco erros de execução. Execuções que já tenham qualquer job continuam em espera; os demais casos permanecem sob as regras originais de espera de 30 minutos e nova tentativa por erro. Execuções `workflow_dispatch` não servem de base para verificação completa.

`deliver-review` encerra e remove os rótulos de entrega assim que a revisão passa. Se for acrescentada enquanto espera as verificações, também para em somente revisão antes do merge. Retirar `deliver` enquanto espera as verificações encerra a rodada e reporta `withdrawn`, indicando que não houve merge nem publicação. Fechar um PR não mesclado primeiro grava falha em `delivery` e depois limpa as etiquetas de entrega, para não deixar quem espera preso em pending. Por padrão usam-se a nova tentativa por falha e os cartões de pergunta da central. Ao integrar uma ferramenta de entrega já existente, `--notify-command` repassa `ask-owner` ao programa de notificação e remove o rótulo depois do sucesso. A devolução grava falha em `delivery` e remove os rótulos de entrega. Devoluções em PRs que já têm `deliver-attended` esperam três minutos e só repassam se ainda não tiver sido removida. Erros temporários usam a reverificação de um minuto da central para novas tentativas; erros de plataforma, como 5xx do GitHub, no máximo 60 vezes, e outros erros de execução no máximo 5 vezes.

A origem das mudanças reconhece apenas o status de commit `delivery-agent/<número do PR>`. Ele é escrito por contas do GitHub especificadas no `review.trusted` do projeto ou no `trusted_submitters` da política compartilhada. Sincronizar limpo com a main mantém a declaração; commits novos ou conflitos resolvidos à mão exigem declarar de novo. A política compartilhada especifica a lista de revisores, nomes podem se repetir, e lista vazia dispensa revisão. Caminhos de revisão profunda ou pedidos de somente revisão prevalecem sobre a dispensa. Documentação interna comum é dispensada de revisão pela política do projeto.

A revisão faz no máximo três rodadas automáticas. Quando a lista de revisores, o modelo ou a profundidade não mudam, começa a revisar depois dos commits já revisados. Ao fim de todos os revisores em cada rodada, escreve na seção “Revisão do Codex” do corpo do PR, validando a rodada por um status escrito com conta GitHub confiável; é possível explicar o procedimento depois de cada item “Tratamento:”. Rodadas antigas sem registro confiável não podem autorizar o merge.

PRs já mesclados com o rótulo `deliver` continuam diretamente sendo acompanhados por Ship e verificação de saúde; com o rótulo já removido, não são mais acompanhados nem recebem status. Os que foram mesclados por outros durante a revisão também continuam acompanhados. Por padrão acompanha no máximo 30 minutos e, ao estourar o tempo, entrega à central para nova tentativa; projetos sem configuração de saúde reportam explicitamente que apenas o merge foi concluído. O escopo da publicação compara **todo o diff entre a versão saudável e o commit alvo**: apenas mudanças de documentação interna comum podem ser puladas; bit executável, links simbólicos, renomeações para caminhos externos e histórico desconhecido exigem publicação; mudanças posteriores só de documentação não podem fazer pular uma publicação de código ainda não concluída. Quando a interface de saúde informa um commit curto, primeiro troca pelo completo no GitHub; não conseguindo trocar, considera que precisa publicar.

O Ship usa o `plugins/delivery/action.yml` deste repositório do motor, com os projetos fixados no commit completo posterior à publicação. A Action só produz `release` e `superseded`, e os passos de publicação já existentes no projeto rodam conforme essa saída. Ela compartilha com o processo de entrega o escopo e a avaliação de saúde em `project.ts`, sem copiar ferramentas no projeto de forma permanente.

URLs de saúde comuns só aceitam HTTPS. Em testes é preciso passar explicitamente `--test-local-health`, e na Action também `test-local-health: 'true'`, para aceitar `http://127.0.0.1`; outros endereços HTTP não são aceitos. As regras de merge do GitHub são definidas pelos mantenedores do projeto.

## Versão e compatibilidade

O número de versão vive apenas nas tags (`v1.2.3`) e não entra em nenhum arquivo. `agent-autoloop --version` lê a tag do commit atual e mostra “não publicado” quando não está em um commit publicado.

| Nesta versão                                        | Como o número muda                     |
| --------------------------------------------------- | -------------------------------------- |
| O uso antigo não roda sem mudar                      | Primeiro dígito sobe: 1.8.3 → 2.0.0     |
| A primeira versão da semana (contada a partir da meia-noite de segunda no horário de Pequim) | Segundo dígito sobe: 1.8.3 → 1.9.0 |
| Cada versão seguinte na mesma semana, incluindo correções urgentes | Terceiro dígito sobe: 1.8.3 → 1.8.4 |

Leia de cima para baixo e aplique a primeira linha que se encaixar. O segundo e o terceiro dígitos dizem apenas qual é a versão daquela semana; capacidades novas e correções podem estar em qualquer um deles. Para saber se pode atualizar sem medo, olhe só o primeiro dígito: se ele não mudou, o uso antigo continua funcionando. Uma correção urgente publicada logo depois da meia-noite de segunda também conta como a primeira versão da semana.

Uso antigo é isto:

- Caminhos, significado dos campos e autenticação das interfaces `/v1`;
- As convenções de plugin (`plugins/<nome>/{agent,channel,source}.ts`);
- `rules.json`;
- Os comandos e argumentos escritos na documentação;
- As convenções de entrega (`ops/delivery.json`, os quatro rótulos, o status `delivery`);
- Os dados deixados por versões antigas continuam utilizáveis nas novas.

Código interno, campos não documentados e textos de prompt não contam. Campos novos não contam como quebra, então plugins e clientes devem ignorar campos que não conhecem. Para remover algo, primeiro marque como obsoleto em uma versão e registre nas notas de lançamento; a remoção de verdade só acontece na próxima versão do primeiro dígito.

`/v1` conta à parte: só muda quando as interfaces HTTP ficam incompatíveis, e o software chegar a 2.0 não significa que o protocolo chega a `/v2`. Versões publicadas não são alteradas depois; havendo problema, publique o número seguinte.

Mudanças comuns publicam no máximo uma versão por dia; correções de crash, perda de dados, problemas de segurança e falha de instalação saem a qualquer momento. O que só altera documentação, testes ou CI não é publicado. Mudanças grandes podem sair primeiro como versão de teste (`v1.2.0-rc.1`), que a instalação e o `update` não pegam.
