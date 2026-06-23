import fs from "node:fs";
import path from "node:path";
const roots=["src","prisma","scripts","sdk",".github"];
const extensions=new Set([".ts",".tsx",".js",".mjs",".json",".md",".csv",".sql",".yml",".yaml",".py",".toml"]);
const decoder=new TextDecoder("utf-8",{fatal:true});
const cp=(...values)=>String.fromCodePoint(...values);
const bad=[cp(0xc3),cp(0xc2),cp(0xe2,0x20ac,0xa2),cp(0xe2,0x20ac,0x201c),cp(0xe2,0x20ac,0x201d),cp(0xef,0xbb,0xbf),cp(0xfffd)];
const failures=[];
function walk(dir){if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(extensions.has(path.extname(file))){let text;try{text=decoder.decode(fs.readFileSync(file))}catch{failures.push(`${file}: UTF-8 inválido`);continue}for(const token of bad)if(text.includes(token))failures.push(`${file}: sequência suspeita U+${[...token].map(c=>c.codePointAt(0).toString(16).toUpperCase()).join(" U+")}`)}}}
for(const root of roots)walk(root);
if(failures.length){console.error(failures.join("\n"));process.exit(1)}
console.log("Encoding UTF-8 validado.");