// `agent-autoloop update`: o que veio do repositório público segue as releases, que já passaram por todas as verificações,
// e não a main, que pode ainda não ter passado. Uma cópia vinda de outro lugar segue esse lugar. O install.sh decide da mesma
// forma, senão uma atualização falharia numa cópia que ele mesmo moveu.
import { spawnSync } from "node:child_process";

const PUBLISHED = "https://github.com/josesilva05/agent-autoloop-br.git";
const RELEASE = /refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/;

function git(root: string, ...args: string[]) {
  const done = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args[0]} falhou: ${done.stderr?.trim() || done.error?.message}`);
  return done.stdout.trim();
}

function latestRelease(root: string) {
  const origin = spawnSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (origin.stdout?.trim() !== PUBLISHED) return null;
  const releases = git(root, "ls-remote", "--refs", "--tags", "origin", "v*")
    .split("\n")
    .flatMap((line) => {
      const found = RELEASE.exec(line);
      return found ? [{ tag: found[1], version: found.slice(2).map(Number) }] : [];
    });
  const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return releases.sort((a, b) => newer(a.version, b.version)).at(-1)?.tag ?? null;
}

/** Traz esta cópia para a versão atual. `to` é a release em que ela ficou, se seguir releases. */
export function updateCode(root: string) {
  const before = git(root, "rev-parse", "HEAD");
  const to = latestRelease(root);
  if (to) {
    git(root, "fetch", "--quiet", "--depth", "1", "origin", `refs/tags/${to}:refs/tags/${to}`);
    git(root, "checkout", "--quiet", "--detach", to);
  } else git(root, "pull", "--quiet", "--ff-only");
  return { changed: git(root, "rev-parse", "HEAD") !== before, to };
}
