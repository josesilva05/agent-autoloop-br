// A suíte de comportamento compartilhado mais verificações nativas de processo e serviço. Fixtures de shell POSIX e caminhos de
// instalação do macOS rodam em Unix; windows.test.ts e install-smoke-windows.ts exercitam os equivalentes nativos de partida, parada, recuperação e instalação.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const unix = new Set([
  "adapters",
  "browser-handoff",
  "business-recipes",
  "channels",
  "ci-scope",
  "claude-app",
  "desktop",
  "delivery-run",
  "dsh",
  "example-plugins",
  "examples",
  "install",
  "loop",
  "plugin-node-path",
  "recipes",
  "releases",
  "service-plist",
  "service-running",
  "try",
  "uninstall",
  "up-lock",
  "windows-service-update",
  "worker",
  "worker-login-shell",
  "worker-lookup",
  "worker-path",
  "worker-tidy",
]);
const files = readdirSync("tests")
  .filter((file) => file.endsWith(".test.ts") && file !== "simulation.test.ts" && !unix.has(file.slice(0, -8)))
  .map((file) => `tests/${file}`);
const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
