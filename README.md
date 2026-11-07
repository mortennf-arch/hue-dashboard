# Hue-dashbord

Et lokalt dashbord for Philips Hue. En liten Node.js-server snakker med Hue-broen over hjemmenettet og viser alt som skjer, uten å gå via skyen.

Prosjektet bygges i faser. Nå er **fase 2** på plass: et dashbord i nettleseren med alle rom, lys og scener, live-hendelser, dørklokkevarsel, sikkerhet og batteristatus. Det meste av lysstyringen fra Hue-appen er også med. Det åpnes på `http://<maskinen>:8095`, også fra mobil på samme Wi-Fi.

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

I dashbordet er alt delt i tre faner: **Lys**, **Musikk** og **Sikkerhet**. Hver fane viser en kort status, for eksempel «3 rom har lyset på» eller «Spiller i Kjøkken», så du ser det viktigste uten å bytte. Dashbordet husker hvilken fane du sist brukte, og dørklokke-varselet vises uansett fane.


- **Rom og soner**: av/på, lysstyrke og scener for hvert rom og hver sone, med fargen lysene har nå. «Alt av» skrur av hele huset.
- **Romvisning**: trykk på navnet til et rom for å styre hver lampe for seg, med av/på, lysstyrke, hvittone og farge, og for å se alle scenene.
- **Rom og soner**: lag nye med «+ Nytt rom» og «+ Ny sone». I romvisningen kan du gi nytt navn, velge romtype, flytte lamper hit og slette.
- **Scener**: lagre lyset slik det er nå som ny scene, gi nytt navn, bytt innholdet til lyset nå, spill dynamisk med valgfri fart, eller slett.
- **Hver lampe** («Mer»): gi nytt navn, blink så du finner den, effekter som stearinlys og peis, soloppgang og solnedgang, hva lampen gjør når strømmen kommer tilbake, og hvilket rom den er i.
- **Farge og hvittone for hele rommet** samtidig.
- **Dørklokke**: et banner når det ringer på, med status fra kameraet. Det blir borte etter 30 minutter eller når du lukker det.
- **Sikkerhet**: dørklokke, kamerabevegelse, ringeklokka inne og eventuelle dør- og vindussensorer.
- **Hendelser**: de siste 100 hendelsene i klartekst.
- **Helse**: lave batterier og enheter som ikke svarer.
- **Musikk (Sonos)**: hva som spilles i hvert rom eller hver gruppe, med albumcover, spill/pause, forrige/neste, volum og demping, og volum per rom når flere rom spiller sammen. «Velg musikk» spiller Sonos-favorittene dine (spillelister, album og radio du har trykket hjerte på i Sonos-appen), og «Rom i gruppen» slår rom sammen eller fra hverandre med ett trykk, eller lar hele huset spille det samme. Dra i fremdriftslinjen for å hoppe i sangen, og åpne «Neste i køen» for å se og hoppe til resten av køen. Med Spotify-nøkler kan du også søke i Spotify der, med filter for artister, sanger, album og spillelister. En artist åpner en artistside med populære sanger, «This Is», album, featuring og artistradio. Krever `SONOS_IP`, se [docs/truenas.md](docs/truenas.md#sonos-valgfritt).
- **I dag**: været fra yr nå, time for time og de neste dagene, med et kort varsel som «Regn fra kl. 15», og tømmekalenderen (Stavanger) med hvilke dunker som hentes når. Krever `HJEM_ADRESSE` og `TOMMEKALENDER_URL`, se [docs/truenas.md](docs/truenas.md#været-fra-yr-valgfritt).
- **Timer**: egen fane, både i dashbordet og på nettbrettet. Velg en tid til venstre (1 minutt til 1 time) eller still med − og +, gi den navn hvis du vil, og trykk Start. Mens den går, vises en stor nedtelling i en ring med +1, +5 og +10 min og Stopp, og alle timere som går, står i en liste til venstre. Til høyre velger du hvordan den skal varsle: lyd, blink med lyset eller rødt lys i rommet du velger (Sonos og varsel på mobilen kommer senere). Valgene kan endres mens timeren går. Timerne går på serveren, så de vises likt overalt og ringer selv om ingen skjerm er åpen. Etter 10 minutter stopper ringingen av seg selv, og lyset blir som før.
- **Støvsuger (Roborock)**: velg rom, støvsug, vask eller begge, sugestyrke, vann og én eller to ganger, og start. Viser begge støvsugerne side om side med batteriikon og tydelig status (støvsuger, vasker moppen, kjører hjem, tørker moppen og så videre), og har pause, hjem til laderen og «Finn». Begge viser et kart som oppdateres mens den jobber, og i to timer etter at den er ferdig. Under «Slitedeler og statistikk» står hvor mye som er igjen på børster, filter og sensorer, og totalt antall runder, timer og m². Logg inn én gang med e-postkode i fanen. Etterpå styres støvsugerne direkte på hjemmenettet. Se [docs/truenas.md](docs/truenas.md#roborock-støvsugere-valgfritt).
- **Bilder**: bilder fra en mappe på TrueNAS, sortert i mappene du har der, pluss «Denne dagen» med bilder fra samme dato tidligere år. Lysbildevisningen fyller hele skjermen, med klokke og vær i hjørnet, og starter av seg selv etter noen minutter uten trykk hvis du vil (standard på nettbrettet). Krever at mappen er koblet til appen, se [docs/truenas.md](docs/truenas.md#bilder-valgfritt).
- **Kjøkkennettbrett** (`/kjokken`): en enklere visning med store knapper for et nettbrett på benken. Kryss av rommene som skal spille (gult = valgt), velg favoritt eller søk i Spotify, styr lys per rom, og få et varsel over hele skjermen når det ringer på. Se [docs/truenas.md](docs/truenas.md#kjøkkennettbrett-valgfritt).

Alt du endrer lagres i broen, så det vises også i Hue-appen. Sletting spør alltid først.

Automasjoner, søk etter nye lamper og Entertainment må fortsatt gjøres i appen.

I loggen (terminalen eller TrueNAS) ser du i tillegg hver rå endring, for eksempel `update  light  Stue taklampe  on.on=false`.

Dashbordet har ingen innlogging, så alle på hjemmenettet kan bruke det. Ikke åpne porten mot internett.

Alt lagres i mappen `data/` (eller `/data` i Docker):

| Fil | Innhold | Kan deles? |
| --- | --- | --- |
| `config.json` | Broens IP, API-nøkkel og sertifikat-fingeravtrykk | **Nei**, nøkkelen gir full styring av lysene |
| `resources.json` | Full tilstand fra broen ved siste oppstart | Ja |
| `events.jsonl` | Alle hendelser, én per linje | Ja |
| `sonos.json` | Adressene til Sonos-høyttalerne appen har sett | Ja |
| `timere.json` | Timere som går, så de overlever en omstart | Ja |

`data/` er i `.gitignore` og havner aldri i git.

## Sikkerhet

Broen bruker et sertifikat som ikke er utstedt av en offentlig CA. I stedet for å slå av sertifikatsjekken lagrer vi broens fingeravtrykk ved paring, og nekter å koble til hvis det endrer seg. Har du byttet bro, sletter du `config.json` og parer på nytt.
