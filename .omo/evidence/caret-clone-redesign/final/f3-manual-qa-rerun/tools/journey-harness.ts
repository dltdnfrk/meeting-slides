import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(process.cwd());
export const appPath = join(process.env.HOME!, "Applications/Meeting Slides.app");
export const marker = join(appPath, "Contents/Resources/project-path.txt");
export const executable = join(appPath, "Contents/MacOS/meeting-slides");

const FIXTURE_SOURCE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args=process.argv.slice(2); const log=process.env.QA_ARGV_LOG;
if(log) appendFileSync(log, JSON.stringify({argv:args})+"\\n");
if(args.includes("--version")){console.log("f3-local-claude-fixture 1.0");process.exit(0)}
const pIndex=args.indexOf("-p"); if(pIndex<0||!args[pIndex+1]){console.error("missing -p prompt");process.exit(2)}
const prompt=args[pIndex+1]; const id=Number(/Meeting ID: (\\d+)/.exec(prompt)?.[1]??1);
if(prompt.includes("You design editable meeting presentations")) console.log(JSON.stringify({meetingId:id,title:"제품 운영 회의",slides:[{intent:"cover",title:"제품 운영 회의",subtitle:"결정과 실행"},{intent:"decision",title:"베타 배포 일정",decision:"금요일 베타 배포",rationale:"QA는 수요일까지 완료"},{intent:"actions",title:"담당 작업",items:[{task:"릴리스 노트 작성",owner:"민수",due:"목요일"}]}]}));
else if(prompt.includes("shouldAdvance")) console.log(JSON.stringify({shouldAdvance:true,title:"베타 배포 일정",kicker:"일정",bullets:["금요일 베타 배포로 확정","QA 마감 수요일 18시","릴리스 노트 민수 담당"],emphasis:"결정: 금요일 베타 배포",kind:"decision"}));
else if(prompt.includes("You extract review candidates")){const version=/"transcriptVersionId"\\s*:\\s*"([^"]+)"/.exec(prompt)?.[1]??"fixture-version";console.log(JSON.stringify({transcriptVersionId:version,decisions:[],actionItems:[],openItems:[]}));}
else if(prompt.includes("회의 질문")||prompt.includes("질문")) console.log("금요일 배포로 결정했고 민수가 릴리스 노트를 담당합니다.");
else console.log(JSON.stringify({items:[]}));
process.exit(0);
`;

export interface Runtime { temporary:string; project:string; port:number; cli:string; whisper:string; argvLog:string; appLog:string; exportsDir:string; bundlesDir:string; databasePath:string }
export function bounded<T>(promise:Promise<T>,label:string,ms=30000):Promise<T>{let timer:ReturnType<typeof setTimeout>;const fail=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timeout:${label}`)),ms)});return Promise.race([promise,fail]).finally(()=>clearTimeout(timer));}
export function shell(command:string):string{const result=Bun.spawnSync(["sh","-c",command],{stdout:"pipe",stderr:"pipe"});return new TextDecoder().decode(result.stdout).trim();}
export function createProject(port:number):Runtime{
 const temporary=mkdtempSync(join(tmpdir(),"f3-manual-qa.")); const project=join(temporary,"project"); mkdirSync(project,{recursive:true});
 for(const file of ["server.ts","package.json","bun.lock","tsconfig.json"]) copyFileSync(join(root,file),join(project,file));
 for(const directory of ["src","public","node_modules","deck","models"]) symlinkSync(join(root,directory),join(project,directory));
 const exportsDir=join(project,"exports"); mkdirSync(exportsDir); const cli=join(temporary,"claude-fixture"); const whisper=join(temporary,"whisper-fixture"); const argvLog=join(temporary,"argv.jsonl"); const appLog=join(temporary,"app.log"); const bundlesDir=join(temporary,"bundles"); const databasePath=join(temporary,"meetings.db");
 writeFileSync(cli,FIXTURE_SOURCE);chmodSync(cli,0o755);writeFileSync(join(temporary,"model.bin"),"fixture");writeFileSync(join(project,".env"),`HTTP_PORT=${port}\n`);
 return {temporary,project,port,cli,whisper,argvLog,appLog,exportsDir,bundlesDir,databasePath};
}
export function writeWhisperFixture(runtime:Runtime,lines:string[],exitCode:number|null=null):void{
 const source=exitCode===null?`#!/usr/bin/env bun\nconst lines=${JSON.stringify(lines)};let i=0;process.on("SIGTERM",()=>process.exit(0));for(const line of lines){const s=(i++).toFixed(3).padStart(6,"0"),e=i.toFixed(3).padStart(6,"0");console.log(\`[00:00:\${s} --> 00:00:\${e}] \${line}\`)}await new Promise(()=>{});\n`:`#!/usr/bin/env bun\nconsole.error("controlled bad input");process.exit(${exitCode});\n`;
 writeFileSync(runtime.whisper,source);chmodSync(runtime.whisper,0o755);
}
function env(runtime:Runtime):NodeJS.ProcessEnv{return {...process.env,MEETINGS_DB_PATH:runtime.databasePath,MEETING_BUNDLE_OUTPUT_ROOT:runtime.bundlesDir,LLM_PROVIDER:"cli",LLM_CLI_BIN:runtime.cli,LLM_CLI_PRESET:"claude",LLM_CLI_TIMEOUT_MS:"20000",QA_ARGV_LOG:runtime.argvLog,WHISPER_INPUT_MODE:"mic",WHISPER_STREAM_BIN:runtime.whisper,WHISPER_MODEL_PATH:join(runtime.temporary,"model.bin"),BLOCK_DETECT_SENTENCE_INTERVAL:"100",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:""};}
export interface LaunchedApp{child:ChildProcess;output:()=>string}
export async function launchApp(runtime:Runtime):Promise<LaunchedApp>{let output="";const child=spawn(executable,[],{env:env(runtime),stdio:["ignore","pipe","pipe"]});const collect=(b:Buffer)=>{output+=b.toString();writeFileSync(runtime.appLog,output)};child.stdout!.on("data",collect);child.stderr!.on("data",collect);await bounded(new Promise<void>((ok,bad)=>{const check=()=>{if(output.includes(`HTTP: http://localhost:${runtime.port}`)&&output.includes("미니바 준비됨"))ok()};child.stdout!.on("data",check);child.stderr!.on("data",check);child.once("error",bad);child.once("exit",c=>bad(new Error(`app exited ${c}: ${output.slice(-1000)}`))) }),"installed-app-ready",60000);return {child,output:()=>output};}
export async function stopApp(app:LaunchedApp|null,runtime:Runtime):Promise<void>{if(app?.child.pid){app.child.kill("SIGTERM");await bounded(new Promise<void>(r=>app!.child.once("exit",()=>r())),"app-exit",15000).catch(()=>app!.child.kill("SIGKILL"));}const p=shell(`lsof -nP -tiTCP:${runtime.port} -sTCP:LISTEN || true`);if(p)shell(`kill -9 ${p.split("\\n").join(" ")}`)}
export function takeMarker(project:string):string{const before=readFileSync(marker,"utf8");writeFileSync(marker,project+"\n");return before}
export function restoreMarker(before:string):boolean{writeFileSync(marker,before);return readFileSync(marker,"utf8")===before}
export function removeRuntime(runtime:Runtime):void{rmSync(runtime.temporary,{recursive:true,force:true})}
