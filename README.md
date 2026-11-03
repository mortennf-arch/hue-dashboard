# Hue-dashbord

Et lokalt dashbord for Philips Hue. En liten Node.js-server snakker med Hue-broen over hjemmenettet og viser alt som skjer, uten å gå via skyen.

Prosjektet bygges i faser. Nå er **fase 2** på plass: et dashbord i nettleseren med alle rom, lys og scener, live-hendelser, dørklokkevarsel, sikkerhet og batteristatus. Det åpnes på `http://<maskinen>:8095`, også fra mobil på samme Wi-Fi.

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
5. Åpne [http://localhost:8095](http://localhost:8095).

Finner den ikke broen, kan du oppgi IP-adressen selv: `npm run dev -- --ip 192.168.1.50`.

## Hva du ser

I dashbordet:

- **Rom**: av/på, lysstyrke og scener for hvert rom, med fargen lysene har nå. «Alt av» skrur av hele huset.
- **Dørklokke**: et banner når det ringer på, med status fra kameraet. Det blir borte etter 30 minutter eller når du lukker det.
- **Sikkerhet**: dørklokke, kamerabevegelse, ringeklokka inne og eventuelle dør- og vindussensorer.
- **Hendelser**: de siste 100 hendelsene i klartekst.
- **Helse**: lave batterier og enheter som ikke svarer.

I loggen (terminalen eller TrueNAS) ser du i tillegg hver rå endring, for eksempel `update  light  Stue taklampe  on.on=false`.

Dashbordet har ingen innlogging, så alle på hjemmenettet kan bruke det. Ikke åpne porten mot internett.

Alt lagres i mappen `data/` (eller `/data` i Docker):

| Fil | Innhold | Kan deles? |
| --- | --- | --- |
| `config.json` | Broens IP, API-nøkkel og sertifikat-fingeravtrykk | **Nei**, nøkkelen gir full styring av lysene |
| `resources.json` | Full tilstand fra broen ved siste oppstart | Ja |
| `events.jsonl` | Alle hendelser, én per linje | Ja |

`data/` er i `.gitignore` og havner aldri i git.

## Sikkerhet

Broen bruker et sertifikat som ikke er utstedt av en offentlig CA. I stedet for å slå av sertifikatsjekken lagrer vi broens fingeravtrykk ved paring, og nekter å koble til hvis det endrer seg. Har du byttet bro, sletter du `config.json` og parer på nytt.
