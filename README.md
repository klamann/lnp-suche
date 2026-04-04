# LNP Suche

Volltextsuche für Transkripte von [Logbuch:Netzpolitik](https://logbuch-netzpolitik.de/).

> ✨ **[Zur Suche](https://klamann.github.io/lnp-suche/)** ✨

## Überblick

LNP Suche ist ein kleines Fan-Projekt, das die automatisch generierten Transkripte von Logbuch:Netzpolitik indexiert und als statische Website mit clientseitiger Volltextsuche bereitstellt. Die Seite wird täglich aktualisiert und auf GitHub Pages gehostet. Ohne Werbung oder Tracking.

- Volltextsuche über alle Episoden mit [Pagefind](https://pagefind.app/)
- Filtern nach Sprecher und Zeitraum, sortieren nach Relevanz oder Datum
- Suchergebnisse linken direkt auf die gefundene Passage im Transkript

## Wie funktioniert's?

Zwei Python-Skripte:

1. `fetch_transcripts.py` lädt den RSS-Feed herunter, extrahiert die VTT-Transkripte und speichert sie lokal zusammen mit Episoden-Metadaten (`meta.json`).
2. `build_index.py` liest die Transkripte und Metadaten, erzeugt pro Episode eine HTML-Seite und baut mit Pagefind einen clientseitigen Suchindex auf.

Workflow: RSS-Feed → `fetch_transcripts.py` → `transcripts/*.vtt` + `meta.json` → `build_index.py` → `dist/` (HTML + Suchindex)

## Lokale Entwicklung

Voraussetzungen: Python 3.11+, [uv](https://github.com/astral-sh/uv), Node.js 20+

```bash
# Transkripte herunterladen (alle Episoden)
uv run fetch_transcripts.py

# Nur die neuesten 3 Episoden laden
uv run fetch_transcripts.py --limit 3

# Statische Seite und Suchindex bauen
uv run build_index.py

# Lokalen Webserver starten
make serve
```

## Deployment

Ein GitHub Actions Workflow läuft täglich um 06:00 UTC, lädt neue Transkripte herunter, committet sie nach `main`, baut den Suchindex und deployt das Ergebnis auf GitHub Pages.

## Lizenz

Der Quellcode steht unter der [GNU Affero General Public License v3](LICENSE). Die Transkript-Inhalte sind geistiges Eigentum von [Logbuch:Netzpolitik](https://logbuch-netzpolitik.de/).
