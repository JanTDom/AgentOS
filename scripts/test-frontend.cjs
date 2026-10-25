const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const buildDir = path.resolve('.agentos-build/frontend-tests');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'package.json'), '{"type":"commonjs"}\n');
for (const name of ['diff', 'chatTrash', 'types', 'skillsCatalog', 'regression.test']) {
  const source = fs.readFileSync(path.resolve(`src/${name}.ts`), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: `${name}.ts`,
  }).outputText;
  fs.writeFileSync(path.join(buildDir, `${name}.js`), output);
}
require(path.join(buildDir, 'regression.test.js'));
