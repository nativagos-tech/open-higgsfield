import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import { MissingCredentialsError } from "./credentials";
import { createPlatformClient } from "./platform";
import type { QueuedGeneration, StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

/* Generation straight from the browser, with the key held in the page.
 
   The studio's default path is the server's: the key lives in an httpOnly
   cookie and the platform is called from a server action, so the secret never
   enters JavaScript. That path needs a server that can reach the platform —
   which a local `pnpm dev` and a Vercel deploy both are, and a browser is not
   required to be. This module is the second path, for a studio served from a
   place whose server cannot reach out: the page calls the platform itself.

   What the trade buys and costs is the key's custody: here it is in
   localStorage, readable by any script on the page, so direct mode is opt-in
   and says so in the dialog. Everything else — the catalog, the settings, the
   request the platform receives — is the same code the server path runs. */

/** The mode's switch and the key it needs. Both live in the browser, not in
    the studio's own stores: the studio's stores are persisted state the user
    owns, these are a deployment's arrangement. */
const MODE_KEY = "openhiggsfield.directMode.v1";
const KEY_KEY = "openhiggsfield.directKey.v1";

/** Direct mode has no server to read `HF_API_BASE_URL` from, so the address is
    compiled in — a public constant, overridable per deployment. */
const DEFAULT_BASE_URL = "https://platform.higgsfield.ai";

export function directBaseUrl(): string {
  return process.env.NEXT_PUBLIC_HF_API_BASE_URL || DEFAULT_BASE_URL;
}

export function directEnabled(): boolean {
  return read(MODE_KEY) === "true";
}

export function setDirectEnabled(on: boolean): void {
  write(MODE_KEY, on ? "true" : null);
}

export function directKey(): string | null {
  const key = read(KEY_KEY);
  return key && key.trim() ? key.trim() : null;
}

export function saveDirectKey(key: string): void {
  write(KEY_KEY, key.trim());
}

export function clearDirectKey(): void {
  write(KEY_KEY, null);
}

/** The platform's answer to `POST /<path>`, from this browser. The plane is
    parsed and mapped by the studio's own code, so a direct request and a
    proxied one carry the same bytes. */
export async function submitDirect(plane: GenerationPlane): Promise<QueuedGeneration> {
  const apiKey = directKey();
  if (!apiKey) throw new MissingCredentialsError();
  const model = getModel(plane.model);
  const parsed: GenerationPlane = { ...plane, settings: parseSettings(model, plane.settings) };
  const { path, body } = toPlatform(parsed);
  return client(apiKey).submit(path, body);
}

/** The same fan-out the server action runs — one request per run, in parallel,
    because here there is no action queue to serialize them behind. */
export async function getDirectStatuses(requestIds: string[]): Promise<StatusResult[]> {
  const apiKey = directKey();
  if (!apiKey) throw new MissingCredentialsError();
  const platform = client(apiKey);
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await platform.status(requestId) };
      } catch (caught) {
        return { requestId, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

function client(apiKey: string) {
  return createPlatformClient({ apiKey, baseUrl: directBaseUrl(), fetch: browserFetch });
}

/** A call a browser is not allowed to make never reaches HTTP: fetch rejects
    with a bare TypeError, which says nothing about why. CORS is the likely
    why, and the honest answer is to send from a server instead.

    Only the transport is translated, and only here — the guard is the `fetch`
    the client is built with, not a try/catch around the whole call, so a
    TypeError from anywhere else still reads as itself. */
const browserFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (caught) {
    if (caught instanceof TypeError) {
      throw new Error(
        `the browser call to ${directBaseUrl()} was blocked before it reached the platform (CORS or network). ` +
          "Turn direct mode off and run the studio where its server can reach the platform",
      );
    }
    throw caught;
  }
};

function read(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* quota, private mode, or a denied store */
  }
}
