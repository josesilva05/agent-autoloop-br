// O menor plugin de Agent. O `printf` substitui um Agent de linha de comando para que isto rode sem modelo e sem conta:
// coloque no lugar dele o modo de impressão do seu CLI e leia o que esse CLI realmente imprime.
// Em rules.json: "agents": { "hello": { "name": "Hello", "worker": "mac-mini", "use": "hello-agent" } }
type Turn = { prompt: string; session: string; resume: string | null; access: "read" | "edit" | "full" };
type Reading = { text?: string; session?: string; error?: string; started?: boolean };

export default {
  command(turn: Turn) {
    const session = turn.resume ?? turn.session;
    const text = `Recebi um prompt de ${turn.prompt.length} caracteres, permissão ${turn.access}. Este é o hello-agent e ele não fez nada.`;
    // Uma linha ao receber o prompt e outra ao terminar: é por essas duas que o `read` abaixo se guia. Um programa cuja
    // única linha vem no fim não consegue dizer se chegou a começar, e um que quebrou acaba sendo executado de novo numa
    // sessão nova.
    return ["printf", "%s\n%s\n", JSON.stringify({ session, started: true }), JSON.stringify({ session, text })];
  },
  // Também é chamado durante a execução, com code null. Um erro lançado aqui conta a rodada como não iniciada, então
  // tudo o que ele não conseguir ler vira um erro que ele retorna.
  // Depois que o seu CLI receber o prompt, retorne started: true sempre, inclusive depois de uma falha: uma rodada que
  // quebrou então é tentada de novo na própria sessão, enquanto uma que nunca começou segue numa sessão nova.
  read(stdout: string, code: number | null, stderr: string): Reading {
    let session: string | undefined;
    let started = false;
    let text: string | undefined;
    for (const line of stdout.split("\n")) {
      try {
        const said = JSON.parse(line);
        if (typeof said?.session === "string") session = said.session;
        if (said?.started === true) started = true;
        if (typeof said?.text === "string") text = said.text;
      } catch {
        // Não é uma linha dele. Durante a execução, a última linha costuma estar escrita só pela metade.
      }
    }
    const known = { ...(session && { session }), ...(started && { started }) };
    if (code === null) return known;
    if (code !== 0) return { ...known, error: stderr.trim() || `código de saída ${code}` };
    return text ? { ...known, text } : { ...known, error: "não deixou resultado" };
  },
  // Com um link, o worker reporta a sessão assim que a execução começa. Uma sessão que ele lê precisa ser uma em que o
  // `resume` consegue continuar: a nova tentativa e a reescrita de um recibo errado dependem disso.
  link: (session: string) => `hello-agent://sessions/${session}`,
};
