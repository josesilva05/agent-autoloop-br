# Como contribuir

Contribuições com problemas reproduzíveis, correções de documentação, plugins e melhorias de capacidade geral são bem-vindas, em português.

## Onde conversar

- [Issues](https://github.com/josesilva05/agent-autoloop-br/issues/new/choose): falhas reproduzíveis e sugestões de funcionalidade com cenário bem definido. O que for viável é corrigido pelos mantenedores, e o commit da correção traz o crédito de quem relatou.
- [Perguntas de uso](https://github.com/josesilva05/agent-autoloop-br/discussions/categories/q-a): instalação, regras, configuração de Agents e canais.
- [Troca de ideias](https://github.com/josesilva05/agent-autoloop-br/discussions/categories/ideas): discutir ideias que ainda não viraram tarefa de desenvolvimento.
- [Compartilhamento de práticas](https://github.com/josesilva05/agent-autoloop-br/discussions/categories/show-and-tell): compartilhar plugins, receitas e experiência de uso.
- Problemas de segurança: contate os mantenedores conforme as [instruções de segurança](SECURITY.md), sem divulgar detalhes de exploração em discussões públicas.

## Escopo das contribuições

Novos Agents, plugins de eventos e canais se conectam na camada de plugins; fluxos de negócio completos podem virar receitas. Leia antes a [documentação de desenvolvimento de plugins](docs/plugins.md) e os [cenários existentes](README.md#receitas-prontas-para-usar) para evitar reimplementar.

O kernel se mantém sem dependências de runtime e não se conecta a produtos externos. Página de visão geral, canvas de workflow e outras interfaces pertencem a clientes independentes e não entram neste repositório. Antes de mudar o protocolo ou o fluxo central, explique o cenário concreto e o impacto em compatibilidade; as convenções de manutenção estão em [AGENTS.md](AGENTS.md) e o protocolo em [docs/protocol.md](docs/protocol.md).

## Enviar mudanças

1. Crie uma branch a partir do `main` mais recente; contribuidores externos usam Fork. As branches deste repositório só podem começar com `claude/`, `codex/` ou `dependabot/`, e tags são usadas apenas para publicação (`v1.2.3`). Agents desenvolvem em worktrees separadas, mantendo o diretório principal em `main`.
2. Use Node.js 24 ou mais novo e rode `npm ci`. Um PR resolve um problema e atualiza em conjunto a documentação, os exemplos e as configurações afetados.
3. Para corrigir um bug, escreva antes um teste que falhe reproduzindo-o, com o início do arquivo de teste explicando qual falha ele evita. Mudanças puras de documentação, modelos ou alterações pequenas e reversíveis não precisam de testes copiados da implementação.
4. Antes de commitar rode `npm run test:quick`, `npm run typecheck` e `npm run format:check`. Quando alterar `kernel/`, `protocol/` ou `sim/`, use `npm test`, que roda adicionalmente a simulação completa e a enumeração. Se envolver log, tabela de vencimentos ou concorrência, rode também `npm run test:nightly`. Para verificações nativas do Windows use `npm run test:windows`. O CI de cada plataforma e a verificação de smoke de instalação estão em [escopo de verificação](AGENTS.md#como-alterar).
5. Abra o PR para `main` explicando o problema, o comportamento após a mudança, o resultado da verificação e o impacto em compatibilidade. Trabalho incompleto usa rascunho; antes do merge confirme que as verificações de Ubuntu, macOS e Windows do commit final passaram, e os mantenedores registram no PR a revisão independente e as validações em máquina real necessárias. Marque "Allow edits by maintainers": os ajustes normalmente são feitos pelos mantenedores diretamente na sua branch antes do merge. O CI do Fork roda nas máquinas do GitHub, automaticamente; o primeiro PR de uma conta recém-criada no GitHub só roda depois da aprovação de um mantenedor.

Os testes usam `AGENT_AUTOLOOP_HOME` temporário, portas aleatórias, HTTP falso local e comandos de notificação falsos. Não conecte a bancos de dados de negócio reais, não envie mensagens e não abra mais um listener de eventos para um aplicativo Feishu já online. O script de entrega real cria e apaga o repositório de teste indicado e só é executado quando o usuário pede explicitamente.

Não commite chaves, links de cartão com permissão, configurações completas, bancos de dados, saída de execução nem materiais de colegas. Logs e capturas de tela nas issues também precisam ser anonimizados antes. O código é enviado sob a [licença MIT](LICENSE).

Os usuários instalam o Release mais recente, não o `main`: mudanças mescladas no `main` só chegam aos usuários no próximo Release; a forma de instalar e atualizar está em [INSTALL.md](INSTALL.md) e a regra dos números de versão no [protocolo](docs/protocol.md#versão-e-compatibilidade); atualmente não há branch de suporte de longo prazo. Neste repositório, os mantenedores conferem a revisão e as verificações das três plataformas seguindo o processo acima e então fazem o merge.
