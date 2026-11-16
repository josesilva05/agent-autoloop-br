# Claude delega o navegador ao Codex

A tarefa principal cuida do negócio, o Codex cuida apenas da página, e a tarefa principal fecha o caso depois de receber as evidências. Há suporte a operações posteriores na mesma sessão do navegador; quando é preciso o titular restabelecer a conexão, o login ou a autenticação, esta rodada se encerra, o cartão volta pelo Feishu e a continuação vem depois da resposta do titular.

## Como ativar

1. Copie este diretório para `~/.agent-autoloop/work/browser-handoff/`, legível apenas pelo titular. Coloque o `SKILL.md` em `~/.claude/skills/claude-browser-handoff/`. Se a tarefa principal passar a usar o Codex, coloque o Skill em `~/.codex/skills/claude-browser-handoff/` e altere o `use` da regra; o padrão continua sendo o Claude como tarefa principal.
2. Configure uma **entrada do Codex que já consiga usar o navegador** e coloque o array de comando real dela em `browser.json.command`. Se já existir um `codex-browser` local, use o caminho absoluto dele. `/path/to/browser-entry` é um espaço reservado; este modelo não instala ponte de navegador, não altera o banco de dados interno do aplicativo de desktop e não copia apelidos SSH, perfis de modelo nem lógica de limpeza de processos do Chrome de nenhuma máquina.
3. Preencha em `browser.json` a URL de destino, os itens a verificar e as operações permitidas. O padrão é uma verificação somente leitura em `example.com`, sem enviar formulários nem mensagens. `allowedActions` é o escopo da tarefa dada ao Agent, não um sandbox do sistema. O escopo das operações deve ser definido pelo titular ou pelas combinações confiáveis de manutenção do projeto, e não pode ser gerado automaticamente a partir de eventos externos. Não coloque credenciais de login na configuração; as URLs de negócio reais e os números de sessão ficam no diretório privado.
4. Mescle os `sources`, `agents`, `channels` e `rules` do `rules.json`, trocando o computador do worker, os diretórios e o open_id do titular no Feishu; reaproveite o canal Feishu e a chave já existentes, sem abrir outra escuta de eventos. Execute `agent-autoloop check`.
5. Permissão: `edit`. Isso indica apenas o modo `acceptEdits` do Claude e **não garante que qualquer comando de entrada do navegador poderá ser executado**. Verifique a permissão de chamada usando o mesmo modo em segundo plano do worker; se a entrada não estiver autorizada, configure-a primeiro a partir das autorizações já existentes do titular, sem mudar automaticamente para `full`. O escopo de operação e as permissões de conta do assistente de navegador também não são concedidos por esse campo.

## Convenção da entrada do navegador

A entrada recebe um único argumento com a tarefa completa: `browser-entry "tarefa de página"`; a continuação recebe `browser-entry --resume <ID de sessão> "tarefa seguinte"`. Ela devolve as evidências reais da página, o resultado das operações e os bloqueios, com `[ID de sessão do Codex: número real]` no fim. Ao usar outra entrada, ofereça a mesma convenção de chamada e de retorno.

O `handoff.ts` só passa a configuração confiável como um argumento, preservando a saída padrão, o erro e o código de saída; não há nova tentativa, e "o comando foi iniciado" não é tratado como conclusão. Uma entrada já existente pode ser executada no computador onde está o navegador, ou repassada por SSH por sua conta; antes, verifique se aquela máquina consegue acessar a URL de destino — um navegador remoto não pode tratar o `localhost` dele como se fosse o computador do worker.

O [`codex exec`](https://developers.openai.com/codex/noninteractive/) do Codex em segundo plano pode usar as suas [ferramentas MCP](https://developers.openai.com/codex/mcp/) configuradas, mas disso não se pode deduzir que ele tenha a conexão com o Chrome do aplicativo de desktop. Só instalar o Codex CLI não basta: é preciso verificar de fato a entrada escolhida; este modelo é uma forma de passar tarefas adiante, não um driver de conexão com o navegador.

## Verificação antes de ativar

No diretório do modelo, execute:

```bash
node handoff.ts browser.json
node handoff.ts browser.json --resume <ID-de-sessão real devolvido no passo anterior>
```

Na primeira vez, confira o título real da página, o título principal visível no corpo e os links; se a página não tiver título principal no corpo, registre isso com sinceridade. Na segunda, confira que a continuação acontece na sessão original; se algo já estiver concluído, ela deve devolver as evidências existentes, sem refazer operações só para continuar. Verifique se as abas que já existiam são preservadas e se as abertas por ela são fechadas. Depois chame o mesmo script pelo modo de inicialização em segundo plano do Claude e confirme que ele realmente recebeu as evidências e o número da sessão. Consultas HTTP não substituem a verificação de página.

Numa central de teste dedicada, envie à fonte `browser-tasks` um evento `browser.verify` com um número estável para disparar a regra; um reenvio do mesmo pedido preserva o `id`, por exemplo:

```json
{"id":"browser-check-1","type":"browser.verify","subject":"site-check","summary":"Verificar a página configurada"}
```

O evento não carrega o comando de entrada, o caminho de destino nem permissões. Para bloqueios que exigem uma ação do titular, encerre a rodada com o `ask` do Skill; se já houver cartão, não repita a delegação nem combine uma nova reverificação por horário. Depois da resposta do titular, continue apenas os passos de página que faltavam.

## Encaixar no negócio existente

Tarefas como tratamento de feedback e inspeção de sites podem carregar este Skill diretamente: coloque o `handoff.ts` deste diretório e o `browser.json` configurado pelo titular no diretório de trabalho privado dela e indique o local na regra confiável da tarefa principal, sem precisar criar mais um agendamento. A tarefa principal conclui primeiro o negócio que consegue fazer, depois delega a verificação da página e por fim devolve o recibo à central; o assistente de navegador não delega de novo nem encerra casos por conta própria.

Os testes automatizados usam uma entrada de navegador falsa para verificar a passagem de argumentos, a continuação de sessão e a propagação de falhas, sem iniciar um Chrome real. Os exemplos publicados contêm apenas URLs de exemplo e espaços reservados; cada pessoa continua tendo de verificar a própria conexão com o navegador e a própria permissão de chamada do Claude.
