// Modos POSIX não protegem segredos no Windows. Um diretório privado dá aos arquivos novos apenas o acesso do titular e do SYSTEM.
import { chmodSync, mkdirSync } from "node:fs";
import { powershell, psQuote } from "./command.ts";

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return chmodSync(directory, 0o700);
  powershell(`
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $folder = ${psQuote(directory)}
    # Definir até o mesmo dono exige o direito de assumir a propriedade, que o Modify de uma unidade de dados não concede.
    if ([IO.Directory]::GetAccessControl($folder, 'Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
      $acl.SetOwner($owner)
    }
    foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($folder, $acl)
  `);
}
