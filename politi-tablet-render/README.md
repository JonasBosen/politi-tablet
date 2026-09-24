# POLITI Tablet

Et mørkt dansk politiinterface til FiveM-rollespil. Løsningen bruger Express, PostgreSQL, server-side sessioner og et responsivt HTML/CSS/JavaScript-interface.

## Funktioner

- Dashboard med registre, seneste sager, ventende ansøgninger og opslag.
- Personregister med søgning, redigering og samlet visning af sager, køretøjer og efterlysninger.
- Sagsberegner der lægger flere bødetakster sammen og automatisk summerer kroner, klip og fængselsdage.
- Køretøjsregister med ejeropslag og redigering.
- Flådestyring med patruljekøretøjer, kaldesignaler, status og medarbejdertilknytning.
- Opkaldsliste med overtagelse, afslutning, telefonlink og interaktivt GTA V-kort med koordinatmarkører.
- FiveM-resource der synkroniserer RP-karakterer automatisk ved login fra Qbox (QBX), QBCore eller ESX.
- Beskyttede FiveM API-ruter til at modtage opkald og synkronisere aktive opkald og patruljepositioner.
- Efterlysninger, opslagstavle, bødetakster og ansøgningsbehandling.
- Medarbejderadministration, revisionslogs og systemindstillinger for administratorer.
- Session-login, bcrypt-adgangskoder og PostgreSQL-baserede sessioner.

## Kør lokalt

1. Installer Node.js 24.21.0 (eller en anden Node.js 24-version).
2. Kør `npm install`.
3. Angiv `DATABASE_URL` til en PostgreSQL-database og `SESSION_SECRET` til en tilfældig hemmelig værdi.
4. Kør `npm start`, og åbn `http://localhost:3000`.

Ved første start oprettes tabellerne automatisk. En tom database får en administratorkonto: `admin` / `admin123`. Skift adgangskoden, før kontoen bruges på en rigtig server.

## Deploy på Render

Projektet ligger i mappen `politi-tablet-render` i GitHub-repositoriet. Sæt Render-servicens **Root Directory** til `politi-tablet-render`, build-kommandoen til `npm install` og start-kommandoen til `npm start`. Node er låst til 24.21.0 i `.node-version` og til major-version 24 i `package.json`.

Konfigurér `DATABASE_URL` til den eksisterende `Dream_Network_politi`-database og `SESSION_SECRET` som en Render-secret. `render.yaml` indeholder også service- og databaseindstillinger til Render Blueprint.

### FiveM-opkald og flådedata

Tilføj `FIVEM_API_KEY` som en hemmelig miljøvariabel på Render-servicen. Brug samme nøgle server-side i FiveM-resource'en, og send den som `Authorization: Bearer <nøgle>`. Nøglen skal aldrig ligge i browserkode eller deles offentligt.

- `POST /api/integrations/calls` opretter et opkald. JSON-felter: `external_id`, `caller_name`, `caller_phone`, `category`, `message`, `x`, `y` og valgfrit `z`.
- `GET /api/integrations/calls/active` returnerer opkald, der ikke er afsluttet.
- `GET /api/integrations/fleet` returnerer politiets flåde og seneste positioner.
- `PATCH /api/integrations/fleet/:callSign/location` opdaterer et køretøjs position med JSON-felterne `x` og `y`.
- `POST /api/integrations/persons` opretter eller opdaterer en RP-karakter ud fra `external_id`, `name`, `birth_date`, `phone`, `address` og `gender`.

Tablet-brugere kan også oprette opkald direkte i Opkaldslisten. FiveM-nøglen er kun nødvendig for eksterne spilressourcer; den interne brugerflade bruger login-sessionen.

### Installer FiveM-synkronisering af RP-karakterer

Kopiér mappen `fivem-resource` til serverens `resources/[local]/politi-tablet-sync`. Omdøb den eventuelt til `politi-tablet-sync`, så startlinjen nedenfor passer. Standardindstillingen er Qbox. Start resource efter `qbx_core` i FiveM-serverens `server.cfg`:

```cfg
set politi_tablet_api_key "SAMME_HEMMELIGE_NØGLE_SOM_PÅ_RENDER"
ensure politi-tablet-sync
```

Opret en hemmelig `FIVEM_API_KEY` på Render-servicen med samme værdi. Nøglen ligger kun i server.cfg og serverresource-koden; læg aldrig server.cfg med nøglen i GitHub. Resource henter Qbox-karakterer via `exports.qbx_core:GetPlayer(source)` (Qbox har ikke det gamle QBCore core-object). Qbox er valgt som standard i `fivem-resource/config.lua`; `qbcore` og `esx` kan stadig vælges dér. Ved spillerens tilslutning prøver resource'en igen, indtil karakteren er indlæst, og synkroniserer navn, fødselsdato, telefon og køn, når frameworket leverer oplysningerne. Den forsøger også adressefelter (`charinfo.address`, metadata-adresse eller ESX `address`/`street`), men standardopsætninger gemmer ikke nødvendigvis en RP-adresse. Hvis serveren bruger et separat boligscript, skal dets adressefelt mappes ind i `fivem-resource/server.lua`.

Karakterens framework-ID bruges som stabil nøgle, så genindtræden opdaterer den eksisterende RP-profil i stedet for at oprette dubletter. Kun dette POLITI Tablet-projekt og dets egen database berøres.

Opkaldskortets baggrund er GTA V-kortfliser fra Rockstar's korttjeneste. Kortfliserne indlæses i browseren fra `s.rsg.sc`; FiveM-koordinater omregnes til kortpositioner, så markører og klik på kortet bruger X/Y-koordinater fra spillet.

## Afgrænsning

POLITI Tablet bruger sin egen Render-service og `Dream_Network_politi`-databasen. Den eksisterende `staff-panel`-service må ikke ændres eller forbindes til dette projekt.

