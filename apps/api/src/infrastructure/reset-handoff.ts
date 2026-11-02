import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, open, unlink } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
const execute = promisify(execFile);
/** Existing operator-owned directory only; never weakens an ACL to make delivery work. */
export async function checkHandoffDirectory(directory: string) {
  const stat = await lstat(directory);
  const canonical = await realpath(directory),
    expected = resolve(directory);
  const samePath =
    process.platform === "win32"
      ? canonical.toLowerCase() === expected.toLowerCase()
      : canonical === expected;
  if (
    !isAbsolute(directory) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath
  )
    throw new Error();
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed=@($sid,'S-1-5-18','S-1-5-32-544')
$acl=[IO.Directory]::GetAccessControl($env:B2B_RESET_HANDOFF_DIRECTORY)
if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){exit 1}
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
 if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){exit 1}
}
Write-Output 'protected'`;
    const result = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4096,
        env: { ...process.env, B2B_RESET_HANDOFF_DIRECTORY: directory },
      },
    );
    if (result.stdout.trim() !== "protected") throw new Error();
  } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error();
}
export async function protectedResetDelivery(path: string) {
  if (!isAbsolute(path)) throw new Error();
  const directory = dirname(path);
  await checkHandoffDirectory(directory);
  try {
    await lstat(path);
    throw new Error();
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  return async (token: string, expiresAt: string) => {
    await checkHandoffDirectory(directory);
    const handle = await open(path, "wx", 0o600);
    let complete = false;
    try {
      await handle.writeFile(
        JSON.stringify({ token, expiresAt }) + "\n",
        "utf8",
      );
      await handle.sync();
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await unlink(path).catch(() => {});
    }
  };
}
