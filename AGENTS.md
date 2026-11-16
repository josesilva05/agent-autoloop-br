# Para os Agents que alteram este repositório

Leia primeiro [docs/protocol.md](docs/protocol.md) e o [diagrama de arquitetura](docs/architecture.svg): eles descrevem a implementação final.

## Princípios

- **O kernel só recebe, só classifica, só despacha e só registra.** `kernel/` não conecta ativamente em nada e não conhece o nome de nenhum produto. `tests/purity.test.ts` protege essas regras e também garante que host, protocol e worker não conheçam produtos específicos. Produtos novos e formas novas de conexão são sempre plugins externos.
- **Não há interface.** A central só tem pontos de entrada: plugins de eventos, worker, canais e o titular. Página de visão geral e telão são clientes feitos por outras pessoas usando esses pontos de entrada e não entram neste repositório. A única página é o link do cartão: um formulário que não executa script, para canais que só conseguem enviar texto.
- **O protocolo é o produto.** Mudar o protocolo é mudar o contrato de todos os plugins: confira antes `docs/protocol.md` e os testes de comportamento existentes e, ao mudar, deixe clara a compatibilidade.
- **Texto é dado, regra é instrução.** O texto dentro do evento não entra no prompt e não influencia quem assume, onde nem com quais permissões.
- **Uma rodada não espera ninguém.** Se precisar perguntar a alguém, encerre a rodada. Não adicione nada que faça o Agent bloquear esperando.
- **Sem dependências de runtime.** O que o Node 24 traz já basta. `package.json` não tem `dependencies`.
- Escreva apenas o código necessário agora. Trava, nova tentativa e fallback exigem um incidente real ou a documentação da interface como base.

## Como alterar

- Testes são escritos antes da implementação, e cada arquivo de teste começa explicando a forma de falha que ele evita; para corrigir um bug, escreva antes um teste que falhe reproduzindo-o. Um teste por comportamento, casos extremos não ganham teste próprio e não se escrevem testes que apenas repetem a implementação.
- `npm test`, `npm run typecheck` e `npm run format:check` precisam passar. Quando `kernel/`, `protocol/` e `sim/` não forem alterados, `npm run test:quick` pula a simulação e a enumeração e roda os demais testes normalmente.
- Antes de mesclar em `main` é obrigatório passar no `check` de Ubuntu, macOS e Windows, e os três conferem o commit final do PR.
- O CI é roteado por `scripts/ci-scope.sh` conforme o escopo da mudança: documentação pura pula tudo; PRs de outros códigos pulam simulação e enumeração; PRs que alteram `kernel/`, `protocol/` e a própria simulação rodam adicionalmente a simulação de 20 mil passos (`npm run test:sim`); só PRs que alteram `tests/simulation.test.ts` ou `sim/enumerate.ts` rodam a verificação completa, e em nenhum outro lugar elas são executadas. Depois de mesclar em main, tudo roda de novo os testes rápidos e o smoke de instalação; a execução já iniciada não é cancelada por pushes seguintes, e as que ainda estão na fila são substituídas pela execução mais nova, que cobre todos os commits anteriores. O workflow `nightly` roda uma vez por dia a simulação de 200 mil passos, enumeração, morte forçada e mutação, além dos testes rápidos e do smoke de instalação com o Node mais recente; PRs que alteram `sim/` ou o próprio workflow rodam apenas morte forçada e mutação. Ao fazer um teste ler algum documento, altere este script em conjunto.
- `npm test` roda a simulação de 200 mil passos com semente fixa e a enumeração com limite; quando envolver log, tabela de vencimentos ou concorrência, rode também `npm run test:nightly`. Mutação precisa provar antes que os testes originais de fato executaram e passaram, sem tratar erro de sintaxe como detecção; qualquer ponto não coberto conta como falha.
- Atualização não escreve migração de dados. O registro de fatos é o único estado autoritativo; projeções e índices são persistidos na mesma transação, reutilizados na inicialização normal e reconstruídos item por item a partir do log quando a impressão digital do formato muda; as colunas das visões de consulta ficam em `host/state.ts`, reconstruídas a cada inicialização, sem arquivos de migração por versão.
- O texto voltado ao usuário usa português simples e direto; comentários de código ficam em português e explicam apenas o porquê que o código não mostra.

## Contribuições da comunidade

- PRs externos devem ser mesclados sempre que possível: o que precisa mudar, os mantenedores ajustam direto na branch da outra pessoa e então mesclam, preservando a autoria do PR e sem fazê-la revisar repetidamente. Só se fecha quando a direção está errada ou é impossível mesclar, e com a razão explicada.
- Issues externas viáveis são corrigidas pelos mantenedores, sem esperar a outra pessoa abrir PR. O commit traz `Fixes #número` e credita quem relatou com `Co-authored-by: <número>+<conta>@users.noreply.github.com`.

## Pontos de revisão

Em PRs que alteram `kernel/`, `worker/`, `protocol/` ou `host/`, antes de mesclar, peça a um Agent que não escreveu aquele código para revisar: entregue apenas o código, sem as conclusões do autor. Ele precisa responder três frases: quem mais usa as funções alteradas; se o que conecta a programas externos tem registro de execução real; e se há problemas do mesmo tipo em outros lugares. Registre no "Como verificar" do PR o número do commit correspondente e a conclusão da revisão e revise de novo sempre que o diff mudar. Em mudanças que envolvem instalação, serviço em segundo plano ou conexão com programas externos, registre também o ambiente em máquina real, os passos executados e os resultados.

A revisão começa assim que o PR é aberto, com vários PRs revisados ao mesmo tempo, sem fila. Dos problemas apontados pela revisão, corrija apenas os obrigatórios. Obrigatório só vale para dois tipos: o que um usuário real muito provavelmente encontraria, ou o que viola a lista abaixo. O que só acontece com várias condições raras juntas é registrado e corrigido quando alguém encontrar, sem entrar no próximo lote; reproduzir com um programa falso não é incidente e não serve de base para adicionar fallback.

A auditoria revisa apenas funcionalidades que alguém realmente usa, entrega primeiro a lista e por padrão não assume que o lote inteiro será corrigido.

Conta como erro:

- Entrar sem chave, ou com uma chave do tipo errado; uma fonte conseguir enviar eventos em nome de outra; o token de uma rodada alcançar outras rodadas; a resposta do canal não conferir quem respondeu e a mensagem original.
- Texto escrito por terceiros dentro do evento entrar no prompt, ou conseguir influenciar quem assume, em qual diretório e com quais permissões.
- O mesmo evento ser registrado duas vezes ou despachado duas vezes; o mesmo grupo iniciar mais rodadas simultâneas do que o permitido; trabalho que falhou ser perdido, ser despachado de novo na hora, ou não ser agrupado com eventos novos do mesmo assunto que chegaram no intervalo.
- A resposta não acordar o assunto que perguntou, ou a resposta a um mesmo cartão ser contada duas vezes; resposta e encerramento alterarem o mesmo cartão.
- Um recibo escrito errado provocar refação do trabalho de negócio.
- O worker perder o resultado de uma rodada concluída, tratar como concluída uma que ainda roda, refazer em sessão nova uma rodada que parou depois de retomar a sessão original, ou deixar subprocessos ao parar.
- Aparecer no kernel requisição para fora, nome de produto ou interface.
- A página do cartão exibir como markup texto escrito por terceiros, ou abrir o link já contar como resposta.
- Plugin, regra ou configuração antigos não funcionarem sem alteração, sendo que esta não é uma versão major (veja o [protocolo](docs/protocol.md#versão-e-compatibilidade)).

## Como fechar um lote

As mudanças são feitas em lotes. Defina a lista do lote ao começar e registre as descobertas novas no meio do caminho para o lote seguinte. Só está terminado quando tudo isto for feito:

- O `check` do `main` e a verificação diária passam.
- O estado das Issues relacionadas está correto.
- Worktrees e branches temporárias foram limpas.
- O Codex revisou todas as mudanças do lote, e os problemas encontrados são corrigidos dentro deste lote. Assim que o primeiro PR que altera kernel ou testes for mesclado, rode a verificação diária e essa revisão, sem deixar para o fim.

Terminar um lote não implica publicar versão; as mudanças se acumulam para a próxima versão regular.

## Como publicar uma versão

Mudanças regulares publicam no máximo uma versão por dia; correções de travamento, perda de dados, problema de segurança e impossibilidade de instalação saem a qualquer momento. Como incrementar o número de versão está no [protocolo](docs/protocol.md#versão-e-compatibilidade). O número de versão fica apenas na tag e não entra em nenhum arquivo. Escolha um commit de `main` cujo check já tenha passado e que tenha sido executado e validado de verdade, rode nele a verificação diária (`gh workflow run nightly.yml --ref main -f commit=<hash completo do commit>`, que inclui a simulação de 200 mil passos e a enumeração) e, depois que passar, aplique a tag nesse commit, deixando claro o que esta versão mudou. Tags publicadas não são movidas nem apagadas.

## Fronteiras do kernel

`decide(view, input, now, environment)` só pode produzir fatos; a decisão e o commit acontecem na mesma transação, a visão é lida pelos índices e a decisão mantém apenas as mudanças desta vez; `evolve` tem exclusividade sobre a gravação da projeção persistente e `commit` sobre o acréscimo ao log. O kernel não lê relógio, não obtém números aleatórios e não lê ambiente nem arquivos. Tempo, mudança de regras, chave mestra e requisição entram pelo host; `host/http.ts` apenas converte a requisição do Node em Request. A visão pode ser reconstruída do log a qualquer momento, e dados de negócio não podem ser alterados contornando o log. Versão das regras, respostas e recibos podem ser lidos por `why` e `/v1/stream`.

## Fronteiras de plugins e entrega

- Plugins embutidos e de terceiros são unificados em `plugins/<nome>/{agent,channel,source}.ts`, com o diretório de instalação tendo prioridade e o kernel não importando plugins. A linha de comando fica em `cli/` e o worker em `worker/`; não adicione outro caminho de descoberta.
- Eventos externos só podem carregar dados. Agent, diretório, permissões, repositório de entrega e comando de revisão são decididos por regras confiáveis e pela main do projeto. Eventos de recibo herdam os hops e, acima de 8 saltos, são registrados mas não continuam sendo despachados.
- O processo de entrega não pode fazer checkout nem executar código, testes, configurações ou hooks do PR; pode apenas transformar objetos Git brutos em snapshot de texto. Por padrão a revisão do Codex ignora configuração e memória do usuário e mantém o sandbox somente leitura do snapshot.
- Fila, concorrência e novo despacho pertencem à central. O plugin de entrega determina o que esta rodada deve fazer pelos status do GitHub e confia à central o registro de reverificação com o número de novas tentativas de entrega; execuções únicas de emergência reutilizam o mesmo fluxo.
- `ops/delivery.json`, os quatro rótulos de entrega e o status `delivery` mantêm a convenção; status de revisão, comando de revisão e o revisor de cada Agent são configuráveis. A decisão de Ship fica em uma Action deste repositório, e as GitHub Actions de dependência são fixadas no SHA completo.
- Lógicas de incidente que precisam ser preservadas, aceitas apenas as encontradas em execução real ou por usuário real: as configurações vêm apenas da main; só as mudanças do próprio branch são revisadas; a resolução de conflitos é preservada; verificação de rascunho não libera; mudança de commit ou da main não mescla; auto-merge confirma o fechamento; resposta de merge perdida é relida; sucesso do Ship é verificado junto com a versão saudável; commits de documentação posteriores não encobrem código não publicado; entregas concluídas não são revertidas por publicações posteriores.
- Outras convenções da entrega, sem base em incidente, podem ser ajustadas diretamente: o commit que apresentou o problema não é revisado uma segunda vez; octopus merge cujo conteúdo não é visível não é liberado; um PR apenas revisado não é mesclado por falha na remoção de rótulos; mudança de branch de destino não mescla; a declaração de origem usa o status de commit `delivery-agent/<nº do PR>`. Uma política compartilhada pode indicar vários revisores para um Agent, e cada rodada só é registrada depois que todos concluírem.
- Ao alterar uma mesma convenção, verifique em conjunto código, protocolo, exemplos, o README, INSTALL, SKILL, SECURITY e o diagrama de arquitetura. Busque caminhos antigos, nomes antigos, quantidades antigas e limites antigos de capacidade. O design é escrito diretamente no protocolo e nas convenções de manutenção.

## Escopo de verificação

Os testes existentes são a especificação de comportamento: não altere o esperado para acomodar a implementação. Quando rodar localmente simulação, enumeração, morte forçada e mutação está em "Como alterar", e a estrutura de verificação não é expandida. Desempenho apenas registra o medido, sem definir linha de corte e sem servir de critério de bloqueio para publicação; não se mantém um segundo kernel para acelerar a simulação. As medições seguem o critério do README e do protocolo: memória ociosa e memória com mil conexões são separadas, e gravação durável não é trocada por commit em lote. Não escreva testes que vigiam números (linhas, memória, quantidade de verificações): limites são protegidos por testes que verificam se houve excesso, e o quanto cresceu vai no relatório para julgamento humano.

Os scripts em máquina real estão em `scripts/real-agents.ts`, `scripts/real-protocols.ts` e `scripts/delivery-e2e.ts`. O script de entrega real exige `owner/name --run`, cria e apaga o repositório privado de teste indicado e só é executado quando o usuário pede explicitamente. Os outros testes usam `AGENT_AUTOLOOP_HOME` temporário e portas aleatórias. O Feishu usa uma CLI falsa; não é permitido abrir mais um listener de eventos em um aplicativo já online. Canais usam um serviço HTTP falso local e não enviam mensagens reais.

Ao preparar o aceite na máquina local com `init --no-service`, remova antes `desktop` de `channels` no `config.json` e no `rules.json` temporários e então inicie o `up`. Só mantenha `desktop` ao validar o canal de desktop, usando um comando falso colocado no início do PATH para receber as notificações. Ao iniciar em segundo plano, registre o PID do processo desta execução e, em encerramento normal, falha ou interrupção, espere o processo sair antes de apagar o diretório temporário.

`scripts/install-smoke.sh` percorre da instalação à desinstalação em um HOME temporário, instalando o código já commitado, e o CI roda em Ubuntu e macOS. No Windows use `scripts/install-smoke-windows.ts`, e para comportamento compartilhado e verificações nativas de processo use `npm run test:windows`. Shell Unix, Homebrew e simulação de serviço continuam sendo validados em Unix, enquanto instalação nativa, notificações e árvore de processos do Windows são cobertos por testes dedicados. O serviço de logon é validado em uma sessão desktop real, e o CI não registra tarefa de usuário.
