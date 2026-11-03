# Consistency Clock

Ein persönlicher Countdown für eine Challenge: große `HH:MM:SS`-Uhr, „N DAYS LEFT“ darunter,
ein Check-in pro Tag, Streak, Verlauf und eine Erinnerung, wenn du bis zur eingestellten Uhrzeit
noch nicht eingecheckt hast.

## Auf dem iPhone installieren

1. Öffne die App-Adresse in **Safari** (nicht in Chrome oder einer anderen App).
2. Tippe auf **Teilen** → **Zum Home-Bildschirm** → **Hinzufügen**.
3. Öffne die App **vom Home-Bildschirm** aus und melde dich an bzw. lege ein Konto an.
4. **Settings** → **Remind me** einschalten und die Mitteilungen erlauben.
5. Mit **Send a test notification** prüfen, ob alles ankommt.

Mitteilungen funktionieren ab iOS 16.4 und nur in der App vom Home-Bildschirm.

## Wie die Erinnerung funktioniert

Alle 10 Minuten prüft die Datenbank, ob deine Erinnerungszeit erreicht ist, ob heute ein Tag
deiner Challenge ist und ob du schon eingecheckt hast. Falls nicht, schickt sie genau eine
Mitteilung an diesem Tag. Die Zeitzone kommt von deinem iPhone.

## Mit Claude Code ändern

Starte eine Claude-Code-Sitzung mit diesem Repository und beschreib die Änderung.
`CLAUDE.md` erklärt Aufbau und Regeln. Nach jedem Push auf `main` veröffentlicht
GitHub Actions die neue Version; die App auf dem iPhone lädt sie beim nächsten Öffnen.

## Aufbau

- Web-App: `index.html`, `styles.css`, `app.js`, `sw.js`
- Daten und Login: Supabase (nur du kannst deine Daten lesen, abgesichert über Row Level Security)
- Erinnerungen: Supabase Edge Function `push` mit Web Push, ausgelöst von `pg_cron`
