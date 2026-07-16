import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateFixture} from '../lib/quality.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dir=path.join(root,'test','fixtures','ground-truth');
let files=[];try{files=(await readdir(dir)).filter(file=>file.endsWith('.json'))}catch{}
if(!files.length){console.error('ยังไม่มี ground-truth JSON ใน test/fixtures/ground-truth');process.exitCode=2}else{
  const results=[];for(const file of files){const fixture=JSON.parse(await readFile(path.join(dir,file),'utf8')),metrics=evaluateFixture(fixture);results.push({file,...metrics})}
  console.table(results);const baseline=results.reduce((sum,item)=>sum+item.baselineWer,0)/results.length,candidate=results.reduce((sum,item)=>sum+item.candidateWer,0)/results.length,improvement=baseline?1-candidate/baseline:0,boundaries=results.map(item=>item.medianBoundaryError).filter(Number.isFinite).sort((a,b)=>a-b),median=boundaries[Math.floor(boundaries.length/2)]??null,silent=results.reduce((sum,item)=>sum+item.silentWordCount,0);console.log({baselineWer:baseline,candidateWer:candidate,werImprovement:improvement,medianBoundaryError:median,silentWordCount:silent});if(improvement<.15||median==null||median>.2||silent>0)process.exitCode=1;
}
