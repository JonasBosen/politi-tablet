# POLITI Tablet

Et mørkt dansk politiinterface til FiveM-rollespil. Løsningen bruger Express, PostgreSQL, server-side sessioner og et responsivt HTML/CSS/JavaScript-interface.

## Funktioner

- Dashboard med registre, seneste sager, ventende ansøgninger og opslag.
- Personregister med søgning, redigering og samlet visning af sager, køretøjer og efterlysninger.
- Køretøjsregister med ejeropslag og redigering.
- Flådestyring med patruljekøretøjer, kaldesignaler, status og medarbejdertilknytning.
- Opkaldsliste med overtagelse, afslutning, telefonlink og kortbaseret valg af koordinater.
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

Tablet-brugere kan også oprette opkald direkte i Opkaldslisten. FiveM-nøglen er kun nødvendig for eksterne spilressourcer; den interne brugerflade bruger login-sessionen.

## Afgrænsning

POLITI Tablet bruger sin egen Render-service og `Dream_Network_politi`-databasen. Den eksisterende `staff-panel`-service må ikke ændres eller forbindes til dette projekt.
