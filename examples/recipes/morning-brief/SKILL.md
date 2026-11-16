---
name: morning-brief
description: Escreva o briefing de hoje: leia as notas e os commits recentes do diretório atual e produza um arquivo. Use quando a central despachar a tarefa agendada.
---

# Escrever o briefing

Use apenas o que existe no diretório atual, sem internet e sem inventar nada.

1. O briefing de hoje é `briefs/YYYY-MM-DD.md`. Se esse arquivo já existir, não o reescreva: escreva na primeira linha "NADA A FAZER: o briefing de hoje já foi escrito" e encerre.
2. Veja os arquivos alterados nos últimos três dias: `find . -type f -mtime -3 -not -path './.git/*' -not -path './briefs/*'`. Se o diretório for um repositório git, veja também `git log --since=3.days --oneline`.
3. Se não houver nada de novo: escreva na primeira linha "NADA A FAZER: não há conteúdo novo nos últimos três dias", encerre e não escreva nenhum arquivo.
4. Escreva o briefing em três seções, com no máximo cinco itens cada e uma frase por item; omita a seção que você não conseguir preencher:
   - O que aconteceu recentemente
   - O que fazer hoje
   - O que merece atenção
5. Na primeira linha da última mensagem, escreva em uma frase a coisa mais importante de hoje, seguida do caminho do arquivo. Essa linha é enviada ao usuário; não anexe recibo.
