// Signs a built installer with the update key so the app will accept it.
//   node sign-update.js dist/Tako.player-Setup-X.Y.Z.exe
// Writes <installer>.sig next to it; upload that .sig with the GitHub release.
// The private key lives only on this machine (keep a backup!); the app has the public half.
// This file is not in the build "files" list, so it never ships inside the app.
const crypto = require('crypto');
const fs = require('fs');

const KEY = process.env.TAKO_UPDATE_KEY || 'E:/Tako.player/keys/update-ed25519-private.pem';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node sign-update.js <installer.exe>');
  process.exit(1);
}
const key = crypto.createPrivateKey(fs.readFileSync(KEY));
const sha = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const sig = crypto.sign(null, Buffer.from(sha), key).toString('base64');
fs.writeFileSync(file + '.sig', sig);
console.log('signed ->', file + '.sig');
