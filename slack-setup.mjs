// Crea i canali del workspace Krevn Studio con descrizione. Uso: SLACK_TOKEN=xoxb-... node slack-setup.mjs
// Richiede gli scope bot channels:manage e channels:write.topic (già nel manifest). Rilanciabile: salta i canali esistenti.
const CHANNELS = [
  ["annunci", "Comunicazioni ufficiali del CEO. Solo annunci, niente discussioni."],
  ["idee", "Un'idea per messaggio, discussione nel thread. 🔥 piace · 🤔 da valutare · ✅ approvata · ❌ scartata"],
  ["feedback-utenti", "Recensioni, commenti Reddit e Instagram, bug segnalati dagli utenti."],
  ["app-aethel", "Aethel: sviluppo, bug, release."],
  ["app-micro-travels", "Micro Travels: sviluppo, bug, release."],
  ["app-rinnova", "Rinnova: sviluppo, bug, release."],
  ["app-relics", "Relics: sviluppo, bug, release."],
  ["web-bora", "Bora: giochi di carte online."],
  ["web-vibely", "Vibely for Spotify."],
  ["android-pixel-routines", "Pixel Routines: automazioni Android."],
  ["release", "Cosa esce e quando. Checklist per ogni lancio."],
  ["social", "Instagram @studiokrevn: idee, bozze, risultati."],
  ["reddit", "r/KrevnStudio: post e commenti."],
  ["agent-announcer", "Usa /announcer status | pause | resume | apps."],
  ["bus-announcer", "Canale tecnico GitHub ↔ Devvit ↔ Worker. Non scrivere qui. Silenzialo."],
  ["agent-instagram", "Bozze dello Studio Post Krevn (in arrivo)."],
  ["agent-hq", "Resoconto serale su app e Instagram (in arrivo)."],
];

const token = process.env.SLACK_TOKEN;
if (!token) { console.error("Imposta SLACK_TOKEN=xoxb-..."); process.exit(1); }

async function api(method, body) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const ids = {};
for (const [name, purpose] of CHANNELS) {
  const c = await api("conversations.create", { name });
  if (!c.ok && c.error !== "name_taken") { console.error(`✗ #${name}: ${c.error}`); continue; }
  if (!c.ok) { console.log(`= #${name} esiste già`); continue; }
  ids[name] = c.channel.id;
  const p = await api("conversations.setPurpose", { channel: c.channel.id, purpose });
  console.log(`✓ #${name} ${c.channel.id}${p.ok ? "" : ` (descrizione non impostata: ${p.error})`}`);
}
if (ids["bus-announcer"]) console.log(`\nSLACK_CHANNEL / SLACK_BUS_CHANNEL = ${ids["bus-announcer"]}`);
