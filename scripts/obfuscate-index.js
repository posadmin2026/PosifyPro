const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const cwd = process.cwd();
const inputPath = path.resolve(cwd, process.argv[2] || 'index.html');
const outputPath = path.resolve(cwd, process.argv[3] || 'build/index.obf.html');

if (!fs.existsSync(inputPath)) {
  console.error(`Input file tapılmadı: ${inputPath}`);
  process.exit(1);
}

const html = fs.readFileSync(inputPath, 'utf8');
const scriptTagRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let transformed = html;
let changed = 0;

transformed = transformed.replace(scriptTagRegex, (full, attrs, body) => {
  if (/src\s*=/.test(attrs || '')) return full;
  if (!String(body || '').trim()) return full;

  const obfuscated = JavaScriptObfuscator.obfuscate(body, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.2,
    deadCodeInjection: false,
    disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayThreshold: 0.8,
    transformObjectKeys: true
  }).getObfuscatedCode();

  changed += 1;
  return `<script${attrs}>\n${obfuscated}\n</script>`;
});

if (!changed) {
  console.error('Obfuscate ediləcək inline <script> tapılmadı.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, transformed, 'utf8');
console.log(`Hazırdır: ${outputPath} (${changed} script obfuscate edildi)`);
