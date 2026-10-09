/** Generate a new contract; never modify retained trial inputs or admission. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [source,destination]=process.argv.slice(2);
if(!source||!destination) throw Error('Usage: prepare-compact-reporting.mjs SOURCE_CONTRACT NEW_OUTPUT_DIRECTORY');
const root=resolve(destination);
if(existsSync(root)) throw Error('Output directory already exists; preserve prior inputs');
const before=readFileSync(source,'utf8');
const pattern=/Keep job\.qa\.md current:[\s\S]*?Do not claim controller checks passed\./g;
if([...before.matchAll(pattern)].length!==1) throw Error('Expected exactly one recognized reporting section; inspect unfamiliar contract manually');
const replacement=readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'reporting-contract.md'),'utf8');
mkdirSync(root,{recursive:true});
writeFileSync(resolve(root,'contract.md'),before.replace(pattern,replacement));
writeFileSync(resolve(root,'operator-prompt.md'),'Read contract.md, tool-adapter.md, job.qa.md, controller-before.json and modifier-note.txt in this directory. Complete the one assigned browser journey. Follow the compact reporting contract, then stop.\n');
writeFileSync(resolve(root,'PREPARATION.md'),'Reporting policy candidate only. Not admitted for execution. Controller must qualify fresh fixture, browser, model, build, budgets and immutable shared inputs; generate fresh identities and hashes for both arms. No old launch gate is copied.\n');
console.log(JSON.stringify({generated:root,admitted:false}));
