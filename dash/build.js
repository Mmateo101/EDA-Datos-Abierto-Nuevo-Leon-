// Cifra dashboard_data.json con la contraseña dada y arma dashboard_final.html
const fs = require('fs');
const CryptoJS = require('crypto-js');

const PASSWORD = process.argv[2];
if(!PASSWORD){
  console.error('Uso: node build.js <contraseña>');
  process.exit(1);
}

const html = fs.readFileSync('index.html', 'utf-8');
const js = fs.readFileSync('app.js', 'utf-8');
const dataStr = fs.readFileSync('dashboard_data.json', 'utf-8');

const encrypted = CryptoJS.AES.encrypt(dataStr, PASSWORD).toString();

let out = html.replace('__DATA_ENC__', encrypted).replace('__APP_JS__', js);
fs.writeFileSync('dashboard_final.html', out, 'utf-8');
console.log('dashboard_final.html generado,', out.length, 'bytes');
console.log('Payload cifrado:', encrypted.length, 'caracteres');
