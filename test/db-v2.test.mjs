import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,projectStore} from '../lib/db.mjs';

test('waveform, speech regions and export jobs persist',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sublabs-v2-')),file=path.join(dir,'test.db'),now=new Date().toISOString();let db=openDatabase(file),store=projectStore(db);
  store.create({id:'p',name:'x.mp4',file:'x',mediaUrl:'/x',width:640,height:360,duration:1,createdAt:now});store.updateAnalysis('p',{waveform:{peaks:[.5]},speechRegions:[{id:'s',start:0,end:1}]});store.createExport({id:'e',projectId:'p',status:'queued',progress:0,label:'queue',createdAt:now,options:{style:{}}});db.close();
  db=openDatabase(file);store=projectStore(db);assert.equal(store.get('p').waveform.peaks[0],.5);assert.equal(store.get('p').speechRegions[0].id,'s');assert.equal(store.getExport('e').status,'queued');store.recoverJobs();assert.equal(store.getExport('e').status,'failed');db.close();await rm(dir,{recursive:true,force:true});
});
