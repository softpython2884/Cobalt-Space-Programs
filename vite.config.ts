import { defineConfig } from 'vite';

// host: true → le serveur de dev écoute sur le réseau local :
// les joueurs LAN ouvrent http://<ip-du-pc>:5173
export default defineConfig({
  server: { host: true },
});
