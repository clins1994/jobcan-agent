import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CookieJar } from "tough-cookie";

/** Session cookies are as good as a password while they last, so the file is private to the user. */
export const SESSION_FILE = process.env.JOBCAN_SESSION_FILE ?? join(homedir(), ".jobcan-mcp", "session.json");

export async function loadJar(file: string = SESSION_FILE): Promise<CookieJar> {
  try {
    return CookieJar.deserializeSync(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return new CookieJar();
  }
}

export async function saveJar(jar: CookieJar, file: string = SESSION_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(jar.serializeSync()), { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function clearJar(file: string = SESSION_FILE): Promise<void> {
  await rm(file, { force: true });
}
