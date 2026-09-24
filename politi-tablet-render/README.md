# POLITI Tablet

Et mørkt dansk politiinterface til FiveM-rollespil. Løsningen bruger Express, PostgreSQL, server-side sessioner og et responsivt HTML/CSS/JavaScript-interface.

## Funktioner

- Dashboard med registre, seneste sager, ventende ansøgninger og opslag.
- Personregister med søgning, redigering og samlet visning af sager, køretøjer og efterlysninger.
- Køretøjsregister med ejeropslag og redigering.
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

## Afgrænsning

POLITI Tablet bruger sin egen Render-service og `Dream_Network_politi`-databasen. Den eksisterende `staff-panel`-service må ikke ændres eller forbindes til dette projekt.
