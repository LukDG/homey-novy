# Versiebeheer

## Schema: `JAAR.MMDD.N`

- `JAAR`: het jaar van de release, bv. `2026`.
- `MMDD`: maand en dag als **één getal zonder voorloopnul** (semver laat geen voorloopnullen toe):
  10 november = `1110`, 27 november = `1127`, 5 januari = `105`.
- `N`: teller voor die dag, begint bij `0`.

Voorbeelden: `2026.1127.0`, `2026.1127.1`, `2027.105.0`.

Eén versie per gepubliceerde upload; nooit twee keer dezelfde versie publiceren.

## Changelog

- `.homeychangelog.json`: per versie een korte tekst voor eindgebruikers (één of twee zinnen, wat de
  gebruiker merkt) in alle 13 talen: en, nl, de, fr, it, sv, no, es, da, ru, pl, ko, ar. Oudere entries
  blijven staan. Homey toont deze tekst in de App Store.
- `CHANGELOG.md`: leesbare versie (nieuwste eerst, alle talen), wordt door het script geschreven.
- Geen changelog in `README.txt`.

## Releasestappen

1. Testen met `homey app run --remote`
2. Versie en changelog zetten:
   - `node scripts/set-version.js "English text" "Nederlandse tekst"`, of
   - `node scripts/set-version.js changelog.json` met een tekst per taal, bv.
     `{ "en": "…", "nl": "…", "de": "…", … }`
3. `homey app validate --level publish`
4. `homey app publish`, daarna certificatie aanvragen in de developer tools

## Geschiedenis

De ontwikkelversies van vóór dit schema (0.1.0 – 0.4.2) zijn omgezet naar de dag waarop ze gemaakt werden:
0.1.0 → 2026.1112.0, 0.2.0 → 2026.1124.0, 0.3.0 → 2026.1124.1, 0.4.0 → 2026.1124.2,
0.4.1 → 2026.1125.0, 0.4.2 → 2026.1127.0.
