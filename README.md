# Hue-dashbord

Et lokalt dashbord for Philips Hue. En liten Node.js-server snakker med Hue-broen over hjemmenettet og viser alt som skjer, uten å gå via skyen.

Prosjektet bygges i faser. Nå er **fase 1** på plass: koble til broen, hente API-nøkkel og se alle hendelser live.

## Kjør på TrueNAS (anbefalt)

Serveren skal til slutt kjøre som en Docker-app på TrueNAS SCALE. Følg [docs/truenas.md](docs/truenas.md) steg for steg.

## Kjør på Windows-PC-en (valgfritt, for testing)

1. Installer [Node.js](https://nodejs.org/) 22 LTS.
2. Last ned repoet og åpne en terminal i mappen.
3. Kjør:

   ```
   npm install
   npm run dev
   ```

4. Trykk på knappen på broen når du blir bedt om det.

Finner den ikke broen, kan du oppgi IP-adressen selv: `npm run dev -- --ip 192.168.1.50`.

## Hva du ser

- En oversikt over alle ressurstyper og enheter broen kjenner til.
- Hver endring live, for eksempel `update  light  Stue taklampe  on.on=false`.

Alt lagres i mappen `data/` (eller `/data` i Docker):

| Fil | Innhold | Kan deles? |
| --- | --- | --- |
| `config.json` | Broens IP, API-nøkkel og sertifikat-fingeravtrykk | **Nei**, nøkkelen gir full styring av lysene |
| `resources.json` | Full tilstand fra broen ved siste oppstart | Ja |
| `events.jsonl` | Alle hendelser, én per linje | Ja |

`data/` er i `.gitignore` og havner aldri i git.

## Sikkerhet

Broen bruker et sertifikat som ikke er utstedt av en offentlig CA. I stedet for å slå av sertifikatsjekken lagrer vi broens fingeravtrykk ved paring, og nekter å koble til hvis det endrer seg. Har du byttet bro, sletter du `config.json` og parer på nytt.
