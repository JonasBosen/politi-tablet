# POLITI Tablet

Render-ready POLITI tablet for a FiveM police RP server.

## Stack
- Node.js + Express
- PostgreSQL
- Server-side sessions
- bcrypt password hashing
- Plain HTML/CSS/JS frontend
- Ready for Render and later FiveM NUI integration

## Deploy on Render
1. Put this repository on GitHub as `JonasBosen/politi-tablet`.
2. In Render, create a **Web Service** from that repository.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node 20
4. Add `DATABASE_URL` pointing at the existing `Dream_Network_politi` database.
5. Add `SESSION_SECRET` as a secret (Render can generate it).
6. Deploy.

The app automatically creates the required tables and seed data on first start.

## Demo account
- Username: `admin`
- Password: `admin123`

Change this password before real production use.

## Important
Do NOT change or connect the existing `staff-panel` service to this project. This app is separate and uses the existing `Dream_Network_politi` PostgreSQL database.
