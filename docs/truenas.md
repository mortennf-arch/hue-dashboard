# Kjøre Hue-dashbordet på TrueNAS SCALE

Denne guiden setter opp serveren som en Docker-app på TrueNAS SCALE. Den tar omtrent 15 minutter. Du trenger tilgang til TrueNAS sitt webgrensesnitt, ruteren din og Hue-appen.

Appen hentes som et ferdig Docker-image fra GitHub (`ghcr.io/mortennf-arch/hue-dashboard`). GitHub bygger imaget automatisk hver gang noe flettes inn i `main`.

## 1. Sjekk TrueNAS-versjonen

Guiden forutsetter TrueNAS SCALE **24.10 (Electric Eel) eller nyere**, som bruker Docker for apper. Du ser versjonen på forsiden (Dashboard) i TrueNAS.

Har du en eldre versjon, si fra, så finner vi en annen vei.

## 2. Gi Hue-broen fast IP-adresse

Inne i en container virker det ikke alltid å lete etter broen automatisk, så vi gir den en fast adresse.

1. Finn broens IP i Hue-appen: **Innstillinger > Hue Bridges > (i)** ved broen din.
2. Logg inn på ruteren og lag en **DHCP-reservasjon** (kalles også «fast IP» eller «statisk lease») for denne adressen. Hvor dette ligger varierer fra ruter til ruter.

Noter adressen, for eksempel `192.168.1.50`.

## 3. Lag et dataset for appens data

Her lagres API-nøkkelen og hendelsesloggen, slik at de overlever oppdateringer.

1. Gå til **Datasets**.
2. Velg poolen din (eller et eksisterende `apps`-dataset) og trykk **Add Dataset**.
3. Navn: `hue-dashboard`.
4. **Dataset Preset: Apps**. Det gir brukeren `apps` (id 568), som appen kjører som, tilgang til å skrive.
5. Trykk **Save**.

Noter hele stien, for eksempel `/mnt/tank/apps/hue-dashboard`. Den står øverst når du markerer datasettet.

## 4. Gjør Docker-imaget offentlig (én gang)

Første gang GitHub bygger imaget, blir det privat, og da kan ikke TrueNAS hente det.

1. Gå til [github.com/mortennf-arch?tab=packages](https://github.com/mortennf-arch?tab=packages) og åpne `hue-dashboard`.
2. Trykk **Package settings** nede til høyre.
3. Under **Danger Zone**: **Change visibility > Public**.

Imaget inneholder bare koden, som allerede ligger åpent på GitHub. API-nøkkelen ligger aldri i imaget.

## 5. Installer appen

1. Gå til **Apps** og trykk **Discover Apps**.
2. Trykk på **⋮** (tre prikker) øverst til høyre og velg **Install via YAML**.
3. Navn: `hue-dashboard`.
4. Lim inn innholdet fra [deploy/truenas-compose.yaml](../deploy/truenas-compose.yaml) og endre de to linjene merket `ENDRE`:
   - `HUE_BRIDGE_IP`: broens adresse fra steg 2
   - stien foran `:/data`: datasettet fra steg 3
5. Trykk **Save**. Appen lastes ned og starter.

## 6. Par med broen

1. Gå til **Apps**, velg `hue-dashboard`.
2. Under **Workloads** trykker du på logg-ikonet ved containeren for å se loggen.
3. Når loggen viser `Trykk på den runde knappen midt på Hue-broen nå`, går du bort og trykker på knappen. Appen venter så lenge som nødvendig.
4. Loggen viser `Paret!` og deretter en oversikt over alle enhetene dine.

Nøkkelen lagres i datasettet, så du trenger bare å gjøre dette én gang.

## 7. Åpne dashbordet

Gå til `http://<truenas-ip>:8095` i nettleseren, for eksempel `http://192.168.1.10:8095`. Det virker også på mobil og nettbrett på samme Wi-Fi. Legg det gjerne til på startskjermen.

Er port 8095 allerede i bruk av en annen app, endrer du den første `8095` i `ports`-linjen til en ledig port.

## 8. Se at det virker

La loggen eller dashbordet stå åpent og:

- skru et lys av og på i Hue-appen
- trykk på en bryter
- ring på dørklokka og gå forbi kameraet

Hver handling skal gi en linje i loggen. Hendelsene lagres også i `events.jsonl` i datasettet. Den filen er nyttig å sende meg, for den viser nøyaktig hva dørklokka sender. `config.json` skal du ikke dele.

## Sonos (valgfritt)

Dashbordet kan også styre Sonos-høyttalerne: se hva som spilles i hvert rom, spill, pause, neste og volum. Det bruker høyttalernes lokale API, så du trenger ingen innlogging.

Appen trenger adressen til **én** av høyttalerne. Den forteller selv om alle de andre.

1. Finn adressen i Sonos-appen: **Innstillinger > System > Om systemet mitt**. Der står IP-adressen ved hvert rom. Velg en høyttaler som alltid står på, gjerne en som ikke går på batteri (altså ikke Roam eller Move).
2. Lag gjerne en DHCP-reservasjon for den i ruteren, slik du gjorde for Hue-broen.
3. I TrueNAS: **Apps > hue-dashboard > Edit**. Legg til denne linjen under `environment`, rett under `HUE_BRIDGE_IP`:

   ```yaml
         SONOS_IP: "192.168.1.60"
   ```

   Bytt ut adressen med den du fant.
4. Trykk **Save**. Loggen skal vise `Sonos: 5 høyttalere i 3 grupper` (med dine tall), og en ny **Musikk**-seksjon dukker opp øverst i dashbordet.

Appen husker alle høyttalerne den har sett i `sonos.json` i datasettet, så den finner dem igjen selv om én av dem får ny adresse.

### Spotify-søk (valgfritt)

Med Spotify-nøkler kan du søke etter artister, låter, album og spillelister i «Velg musikk» og spille dem på et rom.

1. Gå til [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), logg inn og trykk **Create app**. Redirect URI: `http://127.0.0.1:8095/callback`. Kryss av for **Web API**.
2. Under **Settings** finner du **Client ID** og **Client secret**.
3. Legg dem til under `environment` i TrueNAS:

   ```yaml
         SPOTIFY_CLIENT_ID: "..."
         SPOTIFY_CLIENT_SECRET: "..."
   ```

Nøklene brukes bare til å søke. Musikken spilles gjennom Spotify-kontoen som er koblet til Sonos, og appen finner den ut fra en Spotify-favoritt. Ha derfor minst én Spotify-spilleliste som favoritt i Sonos-appen. Spotify krever at den som eier nøklene har Premium.

Har dere flere Spotify-kontoer i Sonos, for eksempel én hver, dukker et valg «Spill fra» opp over søkefeltet. Hver konto blir med når den har minst én favoritt i Sonos. Trykk «Gi navn» for å kalle kontoene for eksempel «Morten» og «Kari». Navnene lagres i `sonos.json`, og hver skjerm husker hvilken konto som sist ble valgt.

## Verisure (valgfritt)

Sikkerhet-fanen kan vise alarmstatus, dører og vinduer, smartlås, temperatur og fukt fra røykvarslerne og Verisure-loggen. Dashbordet bare leser. Det kan ikke slå alarmen av eller på.

Verisure har ikke noe offisielt API, så dette bruker det samme som Verisure-appen, slik Home Assistant gjør. Det kan slutte å virke hvis Verisure endrer noe.

1. I TrueNAS: **Apps > hue-dashboard > Edit**. Legg til under `environment`:

   ```yaml
         VERISURE_USERNAME: "din@epost.no"
         VERISURE_PASSWORD: "passordet"
   ```

   Det er det samme som du logger inn i Verisure-appen med. Vil du heller ha en egen bruker for dashbordet, kan du invitere en ny bruker i Verisure-appen og bruke den.
2. Trykk **Save**, og åpne Sikkerhet-fanen. Har kontoen tofaktor, står det «Send kode». Trykk på den, og skriv inn koden du får på SMS. Serveren husker innloggingen i `verisure.json` i datasettet, så du trenger ikke kode igjen.
3. Loggen viser for eksempel `Verisure «Hjemme»: 3 dør/vindu, 4 temperaturmålere`. Det er enhetene dashbordet fant.

Trykk på et rom under «Temperatur og fukt» for å se grafer for døgnet, uka, måneden eller året. Verisure gir bare ut siste måling, så dashbordet lagrer hver måling selv i `verisure-klima.jsonl` i datasettet. Grafene starter derfor den dagen du slo på Verisure, og blir lengre etter hvert.

Dataene hentes hvert 5. minutt. Verisure sperrer kontoer som spør for ofte, så ikke sett det lavere enn nødvendig (`VERISURE_POLL_S`, minst 60).

## Været fra yr (valgfritt)

Fanen «I dag» viser været nå, de neste timene og de neste dagene, både i dashbordet og på kjøkkennettbrettet. Varselet kommer fra Meteorologisk institutt (yr) og krever ingen nøkkel.

1. I TrueNAS: **Apps > hue-dashboard > Edit**. Legg til adressen deres under `environment`:

   ```yaml
         HJEM_ADRESSE: "Gatenavn 1, 1234 Sted"
   ```

   Adressen slås opp hos Kartverket én gang og huskes i `hjem.json` i datasettet. Den brukes også til tømmekalenderen.
2. Trykk **Save**. Fanen «I dag» dukker opp når appen har startet.

Vil du heller oppgi et punkt på kartet, bruk `HJEM_POSISJON: "59.91,10.75"` (breddegrad, lengdegrad). Finner ikke Kartverket adressen, står det i loggen og i fanen.

## Tømmekalender (valgfritt)

Fanen «I dag» kan også vise når søpla hentes, og hvilke dunker det gjelder. Foreløpig virker dette med Stavanger kommunes tømmekalender.

1. Gå til [Stavangers tømmekalender](https://www.stavanger.kommune.no/renovasjon-og-miljo/tommekalender/finn-kalender/), søk opp adressen og velg den.
2. Kopier lenken fra adressefeltet. Den starter med `https://www.stavanger.kommune.no/renovasjon-og-miljo/tommekalender/finn-kalender/show?ids=`.
3. Legg den til under `environment` i TrueNAS:

   ```yaml
         TOMMEKALENDER_URL: "https://www.stavanger.kommune.no/renovasjon-og-miljo/tommekalender/finn-kalender/show?ids=...&municipality=Stavanger&gnumber=...&bnumber=...&snumber=0"
   ```

Kalenderen hentes to ganger i døgnet og lagres i `tommekalender.json` i datasettet. Loggen viser for eksempel `Tømmekalender: 9 tømmedager, neste 2026-11-06`. Hentes det søppel i dag eller i morgen, står det også øverst på kjøkkennettbrettet og på fanen i dashbordet.

## Roborock-støvsugere (valgfritt)

Fanen **Støvsuger** viser begge støvsugerne side om side. Mens en støvsuger står i laderen, velger du rom (gult = valgt, ingen valgt = hele huset), om den skal støvsuge, vaske eller begge deler, sugestyrke, mengde vann og én eller to ganger, og trykker Start. Mens den jobber, står det stort hva den holder på med akkurat nå, for eksempel «Støvsuger», «Vasker gulvet», «Vasker moppen», «Kjører hjem» eller «Tørker moppen», med knapper for pause, avslutt, hjem til laderen og «Finn» (den piper). Begge støvsugerne viser også et kart under «Akkurat nå», med rommene, hvor støvsugeren er, veien den har kjørt og laderen. Kartet oppdateres hvert 5. sekund. Trykk på kartet for å se det i fullskjerm (det oppdateres der også), og trykk igjen for å lukke. Når runden er ferdig, står «Ferdig kl. …» og kartet i to timer, eller til du trykker «Ny runde». Batteriet vises med et ikon. Under «Slitedeler og statistikk» står slitedeler og totaler. Valgene huskes per støvsuger på hver skjerm. Fanen finnes både i dashbordet og på kjøkkennettbrettet.

Du trenger ikke endre noe i TrueNAS:

1. Åpne fanen **Støvsuger** og skriv e-posten du bruker i Roborock-appen. Trykk **Send kode**.
2. Skriv inn koden du får på e-post, og trykk **Logg inn**.
3. Dashbordet henter støvsugerne, rommene og en lokal nøkkel for hver støvsuger fra Roborock, og leter etter dem på hjemmenettet. Etter det snakker det direkte med støvsugerne, uten å gå via Roborocks sky. Alt lagres i `roborock.json` i datasettet.

Kartet sender ikke støvsugeren over hjemmenettet, så det hentes fra Roborocks sky (MQTT, port 8883) mens den jobber. Loggen viser `Roborock: <navn>: hentet kartet fra skyen` første gang, eller `fikk ikke kartet: ...` hvis noe er galt. Alt annet går fortsatt lokalt.

Roborock har ikke noe offisielt API. Dette gjør det samme som Home Assistant, og kan slutte å virke hvis Roborock endrer noe.

- **Rommene** heter det samme som i Roborock-appen. Har du endret navn eller kart, trykk «Hent støvsugere og rom på nytt» nederst i fanen. Mangler rommene, se i loggen etter linjen `Roborock: <navn>: N rom (...). Svar fra støvsugeren: ...`. Den viser hva støvsugeren svarte.
- **Finner den ikke støvsugeren?** Skriv inn IP-adressen i fanen. Den står i Roborock-appen under støvsugeren (⋯ > Produktinfo) eller i ruteren. Lag gjerne en DHCP-reservasjon, slik du gjorde for Hue-broen. Dashbordet leter i samme nett som Hue-broen. Ligger støvsugerne et annet sted, kan du sette `ROBOROCK_SUBNET: "192.168.1"`.
- **Tar du støvsugeren ut av appen og legger den inn igjen,** får den en ny nøkkel. Trykk da «Hent støvsugere og rom på nytt».
- Vil du skru av fanen helt, sett `ROBOROCK: "off"`.

## Bilder (valgfritt)

Fanen **Bilder** viser bilder fra en mappe på TrueNAS, og kan gå over i lysbildevisning når ingen har trykket på skjermen en stund. Hver mappe rett under bildemappa blir et valg i fanen (for eksempel «Hytta» eller «Sommer 2025»), og «Denne dagen» viser bilder tatt på samme dato tidligere år.

1. Legg bildene i en mappe på TrueNAS, for eksempel via SMB-delingen. Undermapper går fint.
2. Mappen må kunne leses av brukeren `apps` (id 568). Er det et eget dataset, går du til **Datasets**, velger det og trykker **Edit** under **Permissions**. Gi `apps` lesetilgang (Read).
3. I TrueNAS: **Apps > hue-dashboard > Edit**. Legg til en linje under `volumes`, rett under linjen med `:/data`:

   ```yaml
         - /mnt/storage/bilder:/bilder:ro
   ```

   Bytt ut `/mnt/storage/bilder` med stien til mappen din. `:ro` betyr at appen bare kan lese bildene, aldri endre eller slette dem.
4. Trykk **Save**. Loggen viser for eksempel `Bilder: 1234 bilder i 5 mapper`.

Appen ser etter nye bilder hver halvtime, eller når du trykker «Se etter bilder på nytt».

- **Formater:** JPEG, PNG, WebP, GIF og AVIF. Bilder fra iPhone er ofte HEIC, og det kan ikke Chrome vise. Fanen sier hvor mange bilder den hoppet over. Stiller du iPhone på **Innstillinger > Kamera > Formater > Mest kompatibel**, blir nye bilder JPEG.
- **Datoen** hentes fra bildet (EXIF), ellers fra når filen ble lagret.
- **Lysbildevisningen** starter av seg selv etter 5 minutter på nettbrettet. I dashbordet er det av, men det kan slås på i fanen. Valget gjelder bare skjermen der det gjøres. Liggende bilder fyller hele skjermen, og stående bilder vises to og to side om side. Dra fingeren sideveis for å bla fram eller tilbake. Et trykk lukker visningen. Ringer det på døra eller en timer, lukkes den.
- Ligger bildene et annet sted i containeren, kan du sette `BILDER_DIR`. Vil du skru av fanen helt, sett `BILDER: "off"`.

## Kjøkkennettbrett (valgfritt)

En enklere visning med store knapper ligger på `http://<TrueNAS-IP>:8095/kjokken`. Den har fanene Musikk, Lys, Timer, I dag, Støvsuger, Bilder og Sikkerhet.

- **Musikk:** rommene til venstre kommer rett fra Sonos. Rom som er merket med gult, spiller sammen. Trykk på et rom for å legge det til eller ta det ut. Med flere rom valgt får hvert rom sin egen volumknapp, pluss «Alle rom».
- **Lys:** av/på, lysstyrke og scener for hvert Hue-rom.
- **I dag:** været fra yr nå, de neste timene og dagene, og når søpla hentes. Temperaturen står på fanen, og «Restavfall i morgen» dukker opp øverst til høyre dagen før. Krever `HJEM_ADRESSE` og `TOMMEKALENDER_URL`, se over.
- **Støvsuger:** de samme knappene som i dashbordet, bare større. Se Roborock-avsnittet over.
- **Bilder:** bilder fra en mappe på TrueNAS, og lysbildevisning når nettbrettet ikke er i bruk. Se Bilder-avsnittet over.
- **Dørklokke:** når noen ringer på, dekker et varsel hele skjermen med en lyd, uansett hvilken fane som er åpen.

**Oppsett på et Android-nettbrett, uten ekstra apper:**

1. Åpne adressen i Chrome og velg ⋮ > **Legg til på startsiden**. Da får du et eget ikon for kjøkkenvisningen.
2. Siden går over i fullskjerm første gang noen trykker på den, og igjen etter at den er lastet på nytt.
3. Hold skjermen på: Innstillinger > Om nettbrettet, trykk 7 ganger på «Byggnummer», og slå så på «Hold skjermen på» under Utvikleralternativer. Det virker så lenge nettbrettet lader. I tillegg ber siden selv nettleseren om å holde skjermen våken og ikke dimme den mens siden er åpen. Det virker bare når Chrome regner adressen som sikker (https, eller flagget «Insecure origins treated as secure» som du satte opp for å installere siden).
4. Vil du at nettbrettet bare skal vise denne siden, kan du bruke «Skjermfesting» (finnes under Sikkerhet i innstillingene).

Alternativet er appen Fully Kiosk Browser, der grunnversjonen er gratis.

Lyden ved ringing virker etter at noen har trykket på skjermen én gang etter at siden er lastet.

## Oppdatere

Når en ny versjon er flettet inn i `main`, bygger GitHub et nytt image på et par minutter. I TrueNAS går du til **Apps > hue-dashboard > Edit** og trykker **Save**. Med `pull_policy: always` henter den da nyeste image.

Har [deploy/truenas-compose.yaml](../deploy/truenas-compose.yaml) fått nye linjer (for eksempel `ports` da dashbordet kom), legger du dem inn i YAML-en under **Edit** før du lagrer. Behold dine egne verdier for IP og sti.

## Feilsøking

| Melding i loggen | Hva du gjør |
| --- | --- |
| `Fikk ikke svar fra ...:443` | Sjekk at `HUE_BRIDGE_IP` er riktig, og at TrueNAS og broen er på samme nett |
| `Sertifikatet til broen har endret seg` | Har du byttet bro? Slett `config.json` i datasettet og start appen på nytt |
| `EACCES` eller `permission denied` på `/data` | Datasettet mangler Apps-preset. Gi brukeren `apps` skrivetilgang under **Edit Permissions** |
| Appen får ikke hentet imaget | Sjekk at pakken er offentlig (steg 4) |
| Dashbordet åpner seg ikke | Sjekk at `ports` står i YAML-en, og at loggen sier `Dashbordet kjører på ...` |
| `Sonos: Fant ingen Sonos-høyttalere` | Legg til `SONOS_IP` (se Sonos-avsnittet over) |
| `Sonos: Får ikke kontakt med Sonos på ...` | Sjekk at adressen er riktig og at høyttaleren står på. TrueNAS og høyttalerne må være på samme nett |
| Støvsuger-fanen sier «Får ikke kontakt med ...» | Sjekk at støvsugeren er på Wi-Fi (den svarer i Roborock-appen), og at adressen er riktig. Trykk «Let på nytt», eller skriv inn adressen |
