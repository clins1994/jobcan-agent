import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KEYCHAIN_SERVICE } from "./config.js";

const run = promisify(execFile);

/** Reads email (account) + password from macOS Keychain. Never logged, never returned to the model. */
export async function getCredentials(): Promise<{ email: string; password: string }> {
  try {
    const { stdout: attrs } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE]);
    const email = /"acct"<blob>="([^"]+)"/.exec(attrs)?.[1];
    const { stdout: pw } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    const password = pw.trimEnd();
    if (!email || !password) throw new Error("empty");
    return { email, password };
  } catch {
    throw new Error(
      `No Jobcan credentials in Keychain (service "${KEYCHAIN_SERVICE}"). ` +
        `Run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a <your-email> -w`
    );
  }
}
