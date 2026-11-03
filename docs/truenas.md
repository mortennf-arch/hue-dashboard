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
