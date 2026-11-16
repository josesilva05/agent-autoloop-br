// A tarefa de login do Windows roda isto com wscript, que nao tem console, entao o console da propria central fica
// oculto. Uma central que para e iniciada de novo depois de dez segundos, como fazem launchd e systemd. O WSH le este
// arquivo na pagina de codigo do sistema, por isso ele permanece em ASCII; os caminhos chegam como argumentos, que
// preservam qualquer caractere.
var shell = new ActiveXObject("WScript.Shell");
var words = [];
for (var i = 0; i < WScript.Arguments.length; i++) {
  words.push('"' + WScript.Arguments(i).replace(/(\\+)$/, "$1$1") + '"');
}
for (;;) {
  shell.Run(words.join(" "), 0, true);
  WScript.Sleep(10000);
}
