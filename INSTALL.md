# Instruções de instalação (para o Agent)

O usuário pediu que você instale a central de automação de Agents. Primeiro instale, depois percorra o fluxo de pergunta e continuação do tratamento; faça diretamente o que puder fazer sozinho.

## Instalação

Suporta Windows nativo, macOS e Linux. É preciso Node.js 24 ou mais novo, Git e um Agent de linha de comando já autenticado; macOS/Linux também precisam de curl. O Windows usa o PowerShell 5.1 que já vem no sistema, o Agendador de Tarefas e o Windows Script Host (wscript).

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/josesilva05/agent-autoloop-br/main/install.ps1 | iex
```

Por padrão instala em `$env:USERPROFILE\.agent-autoloop` e adiciona o diretório de comandos ao PATH do processo atual e ao PATH do usuário. Windows 10 e 11 instalam sem precisar de administrador: o serviço em segundo plano é uma tarefa de logon da própria conta atual. A exceção é a conta Administrator nativa do Windows (com o UAC ligado): sem elevar não dá para criar a tarefa de logon, e criada com elevação ela faria a central e os Agents despachados por ela rodarem com privilégios completos de administrador. Por isso `service install` recusa e imprime uma linha de PowerShell, usando em vez disso a pasta "Inicializar" para subir a central no logon com privilégios normais. O serviço do Windows fica residente em segundo plano depois que o titular faz logon, sem abrir janela, reinicia automaticamente 10 segundos após encerrar e para depois do logoff; ao gerenciar por SSH também é possível usar `service install`, e a tarefa rodará na sessão do Windows já autenticada. O sandbox nativo do Codex 0.167 apresenta timeout de runner pipe-in em sessões OpenSSH, enquanto a sessão de logon local funciona normalmente — veja [problema conhecido do Codex](https://github.com/openai/codex/issues/37722). Quando a central não sobe e o log mostra `listen EACCES`, na maioria das vezes o Hyper-V ou o WSL colocou a porta na faixa reservada pelo sistema: verifique com `netsh int ipv4 show excludedportrange protocol=tcp` e troque no `config.json` por uma porta fora dessa faixa. Para CI ou testes com comando genérico use `--no-service` e depois rode o comando completo que o instalador imprimiu para iniciar o `up`. Notificações de desktop só aparecem na mesma sessão de logon.

Exemplo de instalação a partir de um repositório local:

```powershell
$env:AGENT_AUTOLOOP_REPO = 'C:\code\agent-autoloop'
& 'C:\code\agent-autoloop\install.ps1' --agent codex --no-service
```

Quando o sistema não permite executar scripts locais, você pode usar, apenas para este comando, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\code\agent-autoloop\install.ps1 --agent codex --no-service`, sem alterar a política de execução global. Os demais parâmetros de instalação são os mesmos do macOS/Linux abaixo.

Ao escrever para o Windows scripts PowerShell com texto em português (por exemplo, um script de polling, ou um script que encapsula um Agent), salve em UTF-8 com BOM: o PowerShell 5.1 lê arquivos sem BOM usando a página de código local, os acentos saem corrompidos e em seguida aparecem erros de sintaxe.

No WSL2 continue instalando como Linux; o serviço residente exige que a distribuição tenha o systemd ativo e, se não tiver, acrescente `--no-service`. As notificações de desktop do WSL2 não chegam à área de trabalho do Windows.

Verifique antes `node --version`. O `node@24` do Homebrew não entra no PATH por padrão; depois de instalar é preciso rodar `export PATH="$(brew --prefix node@24)/bin:$PATH"` e, para valer permanentemente, gravar isso na configuração de shell do usuário. Não faça logon pelo usuário nem leia ou copie credenciais de login.

Este repositório é público: o script de instalação e o código podem ser baixados anonimamente, sem conta no GitHub, sem login e sem GitHub CLI (`gh`). O comando macOS/Linux abaixo instala e ativa o serviço residente iniciado no logon:

```bash
curl -fsSL https://raw.githubusercontent.com/josesilva05/agent-autoloop-br/main/install.sh | sh
```

Recursos como o polling de Issues do GitHub e a entrega de PR exigem adicionalmente um `gh` autenticado, configurado conforme a instrução do cenário correspondente; executar o Agent também continua exigindo o login ou a autorização próprios daquele Agent. A central inicia o Agent em segundo plano, e navegadores e operações de computador disponíveis no aplicativo desktop não necessariamente ficam acessíveis a ele (por exemplo, o Chrome dentro do app do Codex não é usado pelo `codex exec` em segundo plano); para que ele opere páginas web, configure conforme [Acesso ao navegador](docs/plugins.md#acesso-ao-navegador) e depois execute de fato uma vez usando o modo de início em segundo plano.

Tanto a instalação quanto `agent-autoloop update` instalam o Release mais recente, que é a versão aprovada em todas as verificações; mudanças ainda não publicadas em `main` ficam para o próximo Release.

Quando o usuário indicar um repositório local, use o script de instalação daquele diretório e defina `AGENT_AUTOLOOP_REPO` com o caminho absoluto dele. Não baixe o script antigo do GitHub nem faça arquivos não commitados passarem por versão instalada; nesse caso o instalador clona o HEAD do repositório local e o `update` também passa a seguir aquele repositório, ignorando o Release. Se já houver instalação, essa variável não tem efeito e a origem anterior continua valendo; para trocar de origem, rode antes `agent-autoloop uninstall` e instale de novo.

Abaixo, usando `/path/to/agent-autoloop` como exemplo e o Codex já autenticado:

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` escolhe o Claude Code; quando houver apenas outra CLI, acrescente `--command 'hermes chat -Q -q {prompt}'`, com caminhos contendo espaço entre aspas; se o programa não for encontrado, ele não instala. Quando nada é especificado, os Agents instalados na máquina são detectados e o primeiro deles vira o alvo da execução de teste.

O programa é instalado em `~/.agent-autoloop/app`, e a configuração e os registros ficam em `~/.agent-autoloop`. A notificação de desktop vem ativada por padrão; sem sessão gráfica ela é pulada silenciosamente e as perguntas continuam visíveis com `agent-autoloop status`. No macOS/Linux o comando é colocado preferencialmente em `~/.local/bin`, que está no PATH; caso contrário, é escolhido o primeiro diretório gravável do PATH, sem sudo e sem sobrescrever outros programas; não havendo lugar, use o caminho completo impresso pelo instalador.

O instalador e a inicialização da central definem o diretório de dados como `0700` no macOS/Linux e, no Windows, usam ACL permitindo acesso apenas ao titular e ao SYSTEM, inclusive em diretórios já existentes, impedindo que outros usuários do sistema leiam o banco de dados, os eventos e a saída das execuções. O sandbox do Codex no Windows adiciona permissão de leitura para a conta dele nas pastas sob o diretório do usuário, incluindo o diretório de dados; a central revoga isso ao iniciar e, até lá, comandos dentro do sandbox conseguem ler a chave mestra e as chaves da configuração. Os plugins adicionam essa mesma permissão de leitura ao `context.json` de cada rodada. Depois de atualizar, reinicie juntos a central e o worker; o novo `status` usa o resumo de custos fornecido pela central.

Se o formato da projeção mudar durante a atualização, ela é reconstruída automaticamente item por item a partir do log antigo, e a primeira inicialização pode demorar quando o histórico é grande; depois disso, as inicializações normais reutilizam a projeção. O log original e os links de cartões existentes são preservados, sem migração manual.

## HOME temporário, CI ou ausência de gerenciador de serviços

Ao usar um HOME temporário, não instale serviço no sistema e não altere a configuração de shell nem a configuração de Agent do usuário real. Preserve o `AGENT_AUTOLOOP_HOME` dado pelo chamador; use o `CODEX_HOME` real apenas para aproveitar o login do Codex já concluído.

Em ambiente temporário, escolha uma porta livre, rode o script de instalação local e em seguida inicie a central:

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` fica rodando continuamente. Na ferramenta de comandos do Agent, mantenha a sessão em execução que ele devolveu e use outro comando para concluir a verificação; não substitua por `nohup … &`, pois a ferramenta de comandos pode limpar processos em segundo plano ao sair. Rode o comando de verificação só depois de ver o endereço em escuta; se a inicialização falhar, trate primeiro o erro naquela sessão.

Quando o comando não estiver no PATH, troque `agent-autoloop` pelo caminho completo impresso pelo instalador. Testes temporários usam programas ou canais de notificação falsos; no Windows também não devem abrir notificações reais. Não abra mais um listener para um aplicativo Feishu que já está online.

## Verificação

Primeiro confira a instalação e a conexão, depois faça um ciclo completo de perguntas e respostas com um Agent real:

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` consome a cota de modelo do usuário. Em um terminal não interativo, ele imprime a pergunta e o comando `agent-autoloop answer` e sai; isso é espera normal, não falha. Repasse a pergunta ao usuário, responda conforme a escolha dele e rode `agent-autoloop status`; só considere conectado ao ver "execução de teste aprovada". Quando o objetivo for apenas validar a instalação, você pode escolher a segunda opção, verde, para concluir a execução de teste.

Quando o Claude precisar delegar ao Codex o trabalho em páginas web, use o [modelo de handoff de navegador](examples/recipes/browser-handoff/README.md): configure primeiro a entrada pronta e depois valide a primeira chamada e a continuação na sessão original. O modelo não instala driver de navegador nem afrouxa automaticamente as permissões de comando do Claude.

Quando a tarefa também exigir operações na web, verifique além disso, seguindo [Acesso ao navegador](docs/plugins.md#acesso-ao-navegador) e usando o mesmo modo de início em segundo plano, as páginas reais e a continuidade da sessão. `try` só prova o fluxo de perguntas e respostas; a central não fornece automaticamente conexão de navegador nem altera a configuração de ferramentas do Agent. Quando for preciso o titular restabelecer conexão, fazer login ou validar, mantenha os itens pendentes de aceite e entregue via `ask`, sem reexecutar repetidamente o trabalho de negócio já concluído.

Quando nenhum serviço de sistema tiver sido instalado, `doctor` mostrará que o serviço não está em execução; basta verificar se a central, o Agent e o canal de desktop estão online, e não instale um serviço real só para eliminar esse aviso.

## Escrever a primeira regra

Depois de validar a instalação, escolha em [receitas do README](README.md#receitas-prontas-para-usar) uma que corresponda ao que o usuário quer automatizar e escreva a regra seguindo o [manual de configuração](skills/agent-autoloop/SKILL.md); pergunte apenas se o usuário ainda não tiver indicado a finalidade. Verifique com `agent-autoloop check`; as mudanças valem em poucos segundos.

Para o seu negócio, você pode começar pelas três receitas de tratamento de feedback, monitoramento de site e resumo semanal e de negócios no Feishu. Elas usam por padrão o chat privado do titular no Feishu; depois de trocar os placeholders, a configuração e os materiais de negócio ficam em um diretório privado e não são commitados no repositório. As receitas não criam credenciais novas para o usuário nem ampliam as permissões do Feishu.

A notificação de desktop só aparece neste computador. Quando precisar de outro canal, confirme antes o destino e conecte-o seguindo o manual de configuração. Não teste diretamente enviando mensagens privadas ou em grupo. O significado de `access` está na [documentação de plugins](docs/plugins.md#o-que-o-access-realmente-permite); não amplie permissões em nome do usuário.

## Desinstalação

Desinstala o programa e, por padrão, mantém regras, chaves e registros:

```bash
agent-autoloop uninstall
```

Só executa depois da confirmação no terminal; em execução não interativa, acrescente `--yes` para pular a confirmação, e os dados são mantidos do mesmo jeito. Ele apenas para os próprios serviços e processos, remove os comandos e os links de Skill que apontam para si mesmo e apaga o `app` dentro do diretório de instalação. Outros arquivos com o mesmo nome não são tocados; o diretório de dados não é removido.

Depois de validar uma instalação temporária, use `agent-autoloop uninstall --yes` para parar os processos desta execução e em seguida limpe os diretórios temporários que você mesmo criou. Não desinstale a central que o usuário já está usando.

## Documentação

- [Manual de configuração](skills/agent-autoloop/SKILL.md): conectar plugins de eventos, canais e vários computadores.
- O [pipeline de entrega](skills/agent-autoloop/SKILL.md#pipeline-de-entrega) vem com a instalação e começa a receber trabalho depois que as regras de entrega são configuradas conforme o repositório.
- [Protocolo](docs/protocol.md): HTTP, recibos, registro de fatos e recuperação de falhas.
- [Plugins](docs/plugins.md): três exemplos mínimos executáveis.
- [Limites de segurança](SECURITY.md): chaves, permissões de execução e revisão na entrega.

Para verificações de desenvolvimento no Windows use `npm run test:windows` e `node scripts/install-smoke-windows.ts`. Em Linux/macOS use `npm run test:quick` (use `npm test` quando alterar `kernel/`, `protocol/` ou `sim/`), `npm run typecheck` e `npm run format:check`; para a verificação completa de falhas e a medição de desempenho use `npm run test:nightly`. Backup e restauração estão no [manual de configuração](skills/agent-autoloop/SKILL.md#log-e-recuperação). Se `master.key` estiver corrompida, a central recusa iniciar: restaure a partir do backup; sem backup, apague-a e a reinicialização gera uma nova, o que invalida os links de cartões já enviados e as rodadas em execução.
