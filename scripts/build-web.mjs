// Copies the web app into ./www (the folder Capacitor packages into the APK).
// Using a dedicated folder keeps node_modules/ and android/ out of the app.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'www';
const FILES = ['index.html', 'style.css', 'appwrite-ui.css', 'part2.css', 'script.js', 'manifest.json'];
const DIRS = ['js', 'music'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of FILES) {
  if (existsSync(file)) cpSync(file, `${OUT}/${file}`);
  else console.warn(`warning: ${file} not found, skipped`);
}
for (const dir of DIRS) {
  if (existsSync(dir)) cpSync(dir, `${OUT}/${dir}`, { recursive: true });
}
console.log('Web app copied to ./www');
