const archiver = require('archiver');
const { createWriteStream } = require('fs');

const output = createWriteStream('function.zip');
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log('Done:', archive.pointer() + ' bytes');
  process.exit(0);
});

archive.on('error', err => {
  console.error(err);
  process.exit(1);
});

archive.pipe(output);
archive.directory('./build', false);
archive.finalize();