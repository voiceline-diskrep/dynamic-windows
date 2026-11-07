const fs = require('fs');

let s = fs.readFileSync('src/renderer/settings.html', 'utf8');
s = s.replace(/'1\.4\.11'/g, "'1.4.12'");
fs.writeFileSync('src/renderer/settings.html', s, 'utf8');

let readme = fs.readFileSync('README.md', 'utf8');
readme = readme.replace(/1\.4\.11/g, '1.4.12');
fs.writeFileSync('README.md', readme, 'utf8');

console.log('Bumped settings.html and README.md to 1.4.12');
