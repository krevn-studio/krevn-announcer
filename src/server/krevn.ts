import { context, reddit, redis, settings } from "@devvit/web/server";

// App seguite. Relics: aggiungi qui l'id quando ha il link App Store (e in APP_IDS del workflow GitHub).
const APPS = [
  { id: "6780602824", name: "Aethel" },
  { id: "6769732967", name: "Micro Travels" },
  { id: "6826930326", name: "Rinnova", launchOnFirstRun: true }, // uscita il 4/11/2026: post di lancio al primo giro
];
const DAY = 86_400_000;
const PER_APP_GAP = 14 * DAY; // max 1 post per app ogni 14 giorni
const WEEK_MAX = 2; // max 2 post a settimana nel subreddit

type Lookup = {
  version: string; releaseNotes?: string; trackViewUrl: string; trackName: string;
  description?: string; formattedPrice?: string; primaryGenreName?: string;
};
type SlackMsg = { text?: string; ts: string };

// Messaggi nel canale bus di Slack. Il payload è JSON in base64, così Slack non altera &, <, >.
const SNAP = "krevn-snapshot "; // scritto dal workflow GitHub
const CTL = "krevn-control "; // scritto dal worker di /announcer: "pause" o "resume"
const STATUS = "krevn-status "; // scritto da qui dopo ogni controllo

export const decodeB64 = <T>(text: string, prefix: string): T =>
  JSON.parse(Buffer.from(text.slice(prefix.length), "base64").toString("utf8"));
const encodeB64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

async function slack(method: string, init: { query?: string; body?: object }) {
  const token = (await settings.get("slackToken")) as string | undefined;
  if (!token) throw new Error("slackToken non impostato");
  const r = await fetch(`https://slack.com/api/${method}${init.query ? "?" + init.query : ""}`, {
    method: init.body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const j = (await r.json()) as { ok: boolean; error?: string; messages?: SlackMsg[] };
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

async function channelId() {
  const c = (await settings.get("slackChannel")) as string | undefined;
  if (!c) throw new Error("slackChannel non impostato");
  return c;
}

// Messaggi "krevn-snapshot <id> <base64>", uno per app: vale il più recente di ogni app.
export function readSnapshots(messages: SlackMsg[]): Record<string, Lookup | null> {
  const snap: Record<string, Lookup | null> = {};
  for (const m of messages) {
    const parts = m.text?.startsWith(SNAP) ? m.text.slice(SNAP.length).split(" ") : [];
    if (parts.length !== 2 || parts[0] in snap) continue; // salta il vecchio formato e i duplicati più vecchi
    try { snap[parts[0]] = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")); } catch { /* messaggio rovinato: usa il prossimo */ }
  }
  return snap;
}

// L'ultimo comando pause/resume non ancora applicato diventa lo stato salvato in Redis.
export function latestControl(messages: SlackMsg[], lastTs: string): { cmd: "pause" | "resume"; ts: string } | null {
  const m = messages.find((x) => x.text?.startsWith(CTL)); // Slack restituisce dal più recente
  if (!m?.text || Number(m.ts) <= Number(lastTs || 0)) return null;
  const cmd = m.text.slice(CTL.length).trim().split(/\s/)[0];
  return cmd === "pause" || cmd === "resume" ? { cmd, ts: m.ts } : null;
}

// "2.1.3" -> "2.1": cambia solo con major o minor, le patch non fanno post
export const majorMinor = (v: string) => { const [a, b] = v.split("."); return `${Number(a) || 0}.${Number(b) || 0}`; };

// Primi paragrafi della descrizione App Store, tagliati a fine paragrafo (circa 400-900 caratteri).
export function excerpt(text = "", min = 400, max = 900) {
  const out: string[] = [];
  for (const p of text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
    if (out.join("\n\n").length >= min || out.join("\n\n").length + p.length > max) break;
    out.push(p);
  }
  return out.join("\n\n") || text.slice(0, max).trim();
}

export function buildPost(name: string, info: Lookup, launch: boolean) {
  const url = info.trackViewUrl.split("?")[0];
  const notes = (info.releaseNotes || "").trim();
  const desc = excerpt(info.description);
  const meta = [info.formattedPrice && `**Prezzo:** ${info.formattedPrice}`, info.primaryGenreName && `**Categoria:** ${info.primaryGenreName}`]
    .filter(Boolean).join(" · ");
  const title = launch ? `${info.trackName || name} è disponibile su App Store` : `${name} ${info.version}: le novità`;
  const text = [
    launch ? `**${name}** è appena uscita su App Store.` : `**${name} ${info.version}** è disponibile su App Store.`,
    launch && desc ? desc : "",
    notes ? `**Novità**\n\n${notes}` : "",
    meta,
    `**[Scarica ${name} su App Store](${url})**`,
    "Domande, idee o bug? Scrivili nei commenti, leggiamo tutto.",
    "---",
    launch ? `*EN: ${name} is now available on the App Store. Feedback welcome in the comments.*` : `*EN: ${name} ${info.version} is out. Feedback welcome in the comments.*`,
  ].filter(Boolean).join("\n\n");
  return { title: title.slice(0, 300), text };
}

// Cancella versioni viste e limiti post (non la pausa): al giro dopo le app con launchOnFirstRun ripubblicano il lancio.
export async function resetState() {
  const keys = ["krevn:posts", ...APPS.flatMap((a) => [`krevn:v:${a.id}`, `krevn:last:${a.id}`])];
  await redis.del(...keys);
  return keys.length;
}

export async function runCheck(): Promise<string[]> {
  const subredditName = context.subredditName;
  if (!subredditName) throw new Error("subredditName mancante");
  const channel = await channelId();
  const log: string[] = [];
  let paused = (await redis.get("krevn:paused")) === "1";
  try {
    const { messages = [] } = await slack("conversations.history", { query: `channel=${encodeURIComponent(channel)}&limit=100` });

    const ctl = latestControl(messages, (await redis.get("krevn:ctl_ts")) || "0");
    if (ctl) {
      paused = ctl.cmd === "pause";
      await redis.set("krevn:paused", paused ? "1" : "0");
      await redis.set("krevn:ctl_ts", ctl.ts);
      log.push(paused ? "messo in pausa" : "ripreso");
    }
    if (paused) { log.push("in pausa: nessun post"); return log; } // gli aggiornamenti restano in coda fino a resume

    const snap = readSnapshots(messages);
    if (!Object.keys(snap).length) throw new Error("nessuno snapshot App Store su Slack");

    const now = Date.now();
    const posts: number[] = JSON.parse((await redis.get("krevn:posts")) || "[]");
    const recent = posts.filter((t) => now - t < 7 * DAY);

    for (const app of APPS) {
      const key = `krevn:v:${app.id}`;
      if (!(app.id in snap)) { log.push(`${app.name}: manca nel workflow GitHub`); continue; }
      const seen = await redis.get(key); // undefined = mai visto, "none" = non ancora in store
      const info = snap[app.id];
      if (!info) { if (!seen) await redis.set(key, "none"); log.push(`${app.name}: non in store`); continue; }

      const launch = seen === "none" || (!seen && !!app.launchOnFirstRun);
      if (!seen && !launch) { await redis.set(key, info.version); log.push(`${app.name}: registrata ${info.version}`); continue; } // primo giro: niente post retroattivi
      if (!launch && majorMinor(seen) === majorMinor(info.version)) {
        if (seen !== info.version) await redis.set(key, info.version); // patch: aggiorna in silenzio
        continue;
      }

      const lastApp = Number((await redis.get(`krevn:last:${app.id}`)) || 0);
      if (recent.length >= WEEK_MAX || now - lastApp < PER_APP_GAP) { log.push(`${app.name} ${info.version}: rimandato (limite post)`); continue; }

      const post = await reddit.submitPost({ subredditName, ...buildPost(app.name, info, launch) });
      await redis.set(key, info.version);
      await redis.set(`krevn:last:${app.id}`, String(now));
      recent.push(now);
      log.push(`${app.name} ${info.version}: pubblicato ${post.url ?? post.id}`);
    }
    await redis.set("krevn:posts", JSON.stringify(recent));
    return log;
  } catch (err) {
    log.push(`errore: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    // Stato per /announcer status; se fallisce anche questo, l'errore originale resta quello mostrato.
    const status = { at: new Date().toISOString(), paused, log };
    await slack("chat.postMessage", { body: { channel, text: STATUS + encodeB64(status) } }).catch((e) => console.error(e));
  }
}
